//! x402 Gateway Middleware Example (Rust/Axum)
//!
//! Demonstrates the server-side gatekeeper pattern:
//! - Issues 402 challenges for unauthenticated requests
//! - Verifies payment proofs on retry
//! - Gates access to protected endpoints
//!
//! Requires Rust 1.75+ and Axum 0.7.

use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Json, Response},
    routing::get,
    Router,
};
use base64::{engine::general_purpose, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    env,
    net::SocketAddr,
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Challenge {
    v: String,
    scheme: String,
    amount_sats: i64,
    payee_locking_script_hex: String,
    expires_at: i64,
    domain: String,
    method: String,
    path: String,
    query: String,
    req_headers_sha256: String,
    req_body_sha256: String,
    require_mempool_accept: bool,
    confirmations_required: i32,
}

#[derive(Debug, Deserialize)]
struct ProofPayload {
    v: String,
    scheme: String,
    txid: String,
    #[allow(dead_code)]
    rawtx_b64: String,
    challenge_sha256: String,
    request: ProofRequest,
}

#[derive(Debug, Deserialize)]
struct ProofRequest {
    domain: String,
    method: String,
    path: String,
    query: String,
}

#[derive(Serialize)]
struct ErrorBody {
    status: u16,
    code: String,
    message: String,
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Header names included in request-binding hashes (per x402 spec).
const HEADER_ALLOWLIST: &[&str] = &[
    "accept",
    "content-length",
    "content-type",
    "x402-client",
    "x402-idempotency-key",
];

#[derive(Clone)]
struct GatekeeperConfig {
    payee_locking_script_hex: String,
    amount_sats: i64,
    challenge_ttl_secs: i64,
}

/// Shared challenge cache (in-memory). Use Redis in production.
type ChallengeCache = Arc<RwLock<HashMap<String, Challenge>>>;

#[derive(Clone)]
struct AppState {
    cfg: GatekeeperConfig,
    cache: ChallengeCache,
}

// ---------------------------------------------------------------------------
// Hashing utilities
// ---------------------------------------------------------------------------

fn sha256hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn hash_request_headers(headers: &HeaderMap) -> String {
    let mut sorted_keys: Vec<&str> = HEADER_ALLOWLIST.to_vec();
    sorted_keys.sort();

    let mut parts = Vec::new();
    for key in &sorted_keys {
        let value = headers
            .get(*key)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let normalized: String = value.split_whitespace().collect::<Vec<_>>().join(" ");
        parts.push(format!("{}:{}", key, normalized));
    }

    let mut canonical = parts.join("\n");
    if !parts.is_empty() {
        canonical.push('\n');
    }

    sha256hex(canonical.as_bytes())
}

fn hash_empty_body() -> String {
    sha256hex(b"")
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// ---------------------------------------------------------------------------
// Error response helper
// ---------------------------------------------------------------------------

fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    let body = ErrorBody {
        status: status.as_u16(),
        code: code.into(),
        message: message.into(),
    };

    let mut resp = Json(body).into_response();
    *resp.status_mut() = status;
    resp
}

// ---------------------------------------------------------------------------
// x402 Middleware
// ---------------------------------------------------------------------------

async fn x402_middleware(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let proof_header = request
        .headers()
        .get("x402-proof")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    match proof_header {
        None => issue_challenge(&request, &state.cfg, &state.cache),
        Some(proof) => verify_and_serve(request, next, &proof, &state.cfg, &state.cache).await,
    }
}

fn issue_challenge(
    request: &Request,
    cfg: &GatekeeperConfig,
    cache: &ChallengeCache,
) -> Response {
    let uri = request.uri();
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost");

    let challenge = Challenge {
        v: "1".into(),
        scheme: "bsv-tx-v1".into(),
        amount_sats: cfg.amount_sats,
        payee_locking_script_hex: cfg.payee_locking_script_hex.clone(),
        expires_at: now_unix() + cfg.challenge_ttl_secs,
        domain: host.into(),
        method: request.method().as_str().into(),
        path: uri.path().into(),
        query: uri.query().unwrap_or("").into(),
        req_headers_sha256: hash_request_headers(request.headers()),
        req_body_sha256: hash_empty_body(),
        require_mempool_accept: true,
        confirmations_required: 0,
        // nonce_utxo would be leased from pool in production
    };

    let challenge_json = serde_json::to_string(&challenge).unwrap_or_default();
    let challenge_bytes = challenge_json.as_bytes();
    let challenge_hash = sha256hex(challenge_bytes);

    if let Ok(mut map) = cache.write() {
        map.insert(challenge_hash, challenge);
    }

    let encoded = general_purpose::URL_SAFE_NO_PAD.encode(challenge_bytes);

    let mut resp = error_response(
        StatusCode::PAYMENT_REQUIRED,
        "payment_required",
        "Payment required. See X402-Challenge header.",
    );

    let headers = resp.headers_mut();
    headers.insert("x402-challenge", HeaderValue::from_str(&encoded).unwrap());
    headers.insert("x402-accept", HeaderValue::from_static("bsv-tx-v1"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));

    resp
}

async fn verify_and_serve(
    request: Request,
    next: Next,
    proof_header: &str,
    _cfg: &GatekeeperConfig,
    cache: &ChallengeCache,
) -> Response {
    // Step 1: Decode proof
    let proof_bytes = match general_purpose::URL_SAFE_NO_PAD.decode(proof_header) {
        Ok(b) => b,
        Err(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "invalid_proof",
                "cannot decode proof",
            )
        }
    };

    let proof: ProofPayload = match serde_json::from_slice(&proof_bytes) {
        Ok(p) => p,
        Err(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "invalid_proof",
                "cannot parse proof JSON",
            )
        }
    };

    // Step 2: Validate version and scheme
    if proof.v != "1" || proof.scheme != "bsv-tx-v1" {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_scheme",
            "unsupported version or scheme",
        );
    }

    // Step 3: Look up original challenge
    let challenge = {
        let map = cache.read().unwrap();
        map.get(&proof.challenge_sha256).cloned()
    };

    let challenge = match challenge {
        Some(c) => c,
        None => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "challenge_not_found",
                "challenge not found or expired",
            )
        }
    };

    // Step 4: Check expiry
    if challenge.expires_at <= now_unix() {
        return error_response(
            StatusCode::PAYMENT_REQUIRED,
            "expired_challenge",
            "challenge has expired",
        );
    }

    // Step 5: Verify request binding
    let uri = request.uri();
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost");

    if proof.request.domain != host
        || proof.request.method != request.method().as_str()
        || proof.request.path != uri.path()
        || proof.request.query != uri.query().unwrap_or("")
    {
        return error_response(
            StatusCode::FORBIDDEN,
            "invalid_binding",
            "request binding mismatch",
        );
    }

    // In production: verify nonce spend, payee output, mempool acceptance
    // (see verify-payment-proof.md skill for complete 16-step verification)

    // Step 6: Compute receipt: SHA256(txid + ":" + challenge_sha256)
    let receipt_hash = sha256hex(format!("{}:{}", proof.txid, proof.challenge_sha256).as_bytes());

    // Delete challenge (single-use)
    if let Ok(mut map) = cache.write() {
        map.remove(&proof.challenge_sha256);
    }

    // Step 7: Serve protected response with receipt headers
    let mut resp = next.run(request).await;
    let headers = resp.headers_mut();
    headers.insert(
        "x402-receipt",
        HeaderValue::from_str(&receipt_hash).unwrap(),
    );
    headers.insert("x402-status", HeaderValue::from_static("accepted"));

    resp
}

// ---------------------------------------------------------------------------
// Protected handler
// ---------------------------------------------------------------------------

async fn expensive_resource() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": "premium content",
        "message": "Payment verified. Access granted."
    }))
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({"status": "ok"}))
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8402);

    let state = AppState {
        cfg: GatekeeperConfig {
            payee_locking_script_hex: env::var("PAYEE_SCRIPT")
                .unwrap_or_else(|_| "76a914000000000000000000000000000000000000000088ac".into()),
            amount_sats: env::var("AMOUNT_SATS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(100),
            challenge_ttl_secs: env::var("CHALLENGE_TTL")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(300),
        },
        cache: Arc::new(RwLock::new(HashMap::new())),
    };

    let app = Router::new()
        .route(
            "/v1/expensive",
            get(expensive_resource)
                .route_layer(middleware::from_fn_with_state(state.clone(), x402_middleware)),
        )
        .route("/health", get(health))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("x402 gateway listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
