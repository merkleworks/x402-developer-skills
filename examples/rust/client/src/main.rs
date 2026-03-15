//! x402 Client Example (Rust)
//!
//! Demonstrates the x402 payment flow:
//! 1. Send request → receive 402 + challenge
//! 2. Parse challenge → build partial tx
//! 3. Submit to delegator → receive completed tx
//! 4. Broadcast tx → retry with proof
//!
//! This example uses no BSV SDK — it constructs raw transaction bytes
//! to illustrate the wire protocol directly.

use base64::{engine::general_purpose, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::env;

// ---------------------------------------------------------------------------
// Protocol types (matching x402 wire format)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
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
    nonce_utxo: Option<NonceRef>,
    template: Option<TemplateRef>,
    #[allow(dead_code)]
    require_mempool_accept: bool,
    #[allow(dead_code)]
    confirmations_required: i32,
}

#[derive(Debug, Deserialize)]
struct NonceRef {
    txid: String,
    vout: u32,
    satoshis: u64,
    #[allow(dead_code)]
    locking_script_hex: String,
}

#[derive(Debug, Deserialize)]
struct TemplateRef {
    rawtx_hex: String,
    #[allow(dead_code)]
    price_sats: u64,
}

#[derive(Debug, Serialize)]
struct DelegationRequest {
    partial_tx: String,
    challenge_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    payee_locking_script_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    amount_sats: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nonce_outpoint: Option<NonceOutpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    template_mode: Option<bool>,
}

#[derive(Debug, Serialize)]
struct NonceOutpoint {
    txid: String,
    vout: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    satoshis: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct DelegationResult {
    txid: String,
    completed_tx: Option<String>,
    rawtx_hex: Option<String>,
}

#[derive(Debug, Serialize)]
struct Proof {
    v: String,
    scheme: String,
    txid: String,
    rawtx_b64: String,
    challenge_sha256: String,
    request: RequestBinding,
}

#[derive(Debug, Serialize)]
struct RequestBinding {
    domain: String,
    method: String,
    path: String,
    query: String,
    req_headers_sha256: String,
    req_body_sha256: String,
}

// ---------------------------------------------------------------------------
// Challenge parsing
// ---------------------------------------------------------------------------

/// Parse the X402-Challenge header value.
///
/// Accepts plain base64url JSON or compact prefix form `v1.bsv-tx.<base64url>`.
/// Returns (challenge, challenge_hash_hex).
fn parse_challenge(header_value: &str) -> Result<(Challenge, String), Box<dyn std::error::Error>> {
    // Strip optional "v1.bsv-tx." prefix if present
    let parts: Vec<&str> = header_value.splitn(3, '.').collect();
    let payload = if parts.len() == 3 && parts[0] == "v1" && parts[1] == "bsv-tx" {
        parts[2]
    } else {
        header_value
    };

    // base64url decode (no padding)
    let raw_bytes = general_purpose::URL_SAFE_NO_PAD.decode(payload)?;

    // SHA-256 of raw bytes = challenge hash
    let mut hasher = Sha256::new();
    hasher.update(&raw_bytes);
    let challenge_hash = hex::encode(hasher.finalize());

    let challenge: Challenge = serde_json::from_slice(&raw_bytes)?;

    if challenge.nonce_utxo.is_none() {
        return Err("Challenge missing nonce_utxo".into());
    }

    Ok((challenge, challenge_hash))
}

// ---------------------------------------------------------------------------
// Transaction construction (Profile A)
// ---------------------------------------------------------------------------

/// Build an unsigned BSV transaction with one input (nonce UTXO) and one
/// output (payee payment).
///
/// BSV raw transaction format:
///   version (4 LE) | inputCount (varint) | inputs | outputCount (varint) | outputs | locktime (4 LE)
fn build_unsigned_partial_tx(
    nonce_txid: &str,
    nonce_vout: u32,
    locking_script_hex: &str,
    amount_sats: i64,
) -> Result<String, Box<dyn std::error::Error>> {
    let mut buf = Vec::new();

    // Version (4 LE)
    buf.extend_from_slice(&1u32.to_le_bytes());

    // Input count (varint)
    buf.push(1u8);

    // Previous output hash (reversed txid bytes)
    let mut txid_bytes = hex::decode(nonce_txid)?;
    txid_bytes.reverse();
    buf.extend_from_slice(&txid_bytes);

    // Previous output index (4 LE)
    buf.extend_from_slice(&nonce_vout.to_le_bytes());

    // ScriptSig length (0 — unsigned)
    buf.push(0u8);

    // Sequence
    buf.extend_from_slice(&0xFFFFFFFFu32.to_le_bytes());

    // Output count (varint)
    buf.push(1u8);

    // Value (8 LE)
    buf.extend_from_slice(&(amount_sats as u64).to_le_bytes());

    // Locking script
    let script = hex::decode(locking_script_hex)?;
    encode_varint(&mut buf, script.len() as u64);
    buf.extend_from_slice(&script);

    // Locktime (4 LE)
    buf.extend_from_slice(&0u32.to_le_bytes());

    Ok(hex::encode(buf))
}

/// Encode an integer as a Bitcoin varint.
fn encode_varint(buf: &mut Vec<u8>, n: u64) {
    if n < 0xFD {
        buf.push(n as u8);
    } else if n <= 0xFFFF {
        buf.push(0xFD);
        buf.extend_from_slice(&(n as u16).to_le_bytes());
    } else if n <= 0xFFFFFFFF {
        buf.push(0xFE);
        buf.extend_from_slice(&(n as u32).to_le_bytes());
    } else {
        buf.push(0xFF);
        buf.extend_from_slice(&n.to_le_bytes());
    }
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let target_url =
        env::var("TARGET_URL").unwrap_or_else(|_| "http://localhost:8402/v1/expensive".into());
    let delegator_url =
        env::var("DELEGATOR_URL").unwrap_or_else(|_| "http://localhost:8402".into());
    let delegator_path = "/delegate/x402";

    let client = reqwest::Client::new();

    // Step 1: Send initial request
    println!("Step 1: Sending initial request...");
    let resp = client.get(&target_url).send().await?;

    if resp.status().as_u16() != 402 {
        println!(
            "Got status {} (not 402): {}",
            resp.status(),
            resp.text().await?
        );
        return Ok(());
    }

    // Step 2: Parse challenge
    let challenge_header = resp
        .headers()
        .get("x402-challenge")
        .ok_or("402 response missing X402-Challenge header")?
        .to_str()?
        .to_string();

    println!("Step 2: Parsing challenge...");
    let (challenge, challenge_hash) = parse_challenge(&challenge_header)?;
    println!(
        "  scheme={} amount={} sats",
        challenge.scheme, challenge.amount_sats
    );

    let nonce = challenge
        .nonce_utxo
        .as_ref()
        .ok_or("missing nonce_utxo")?;
    println!("  nonce={}:{}", nonce.txid, nonce.vout);

    // Step 3: Check expiry
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs() as i64;

    if challenge.expires_at > 0 && challenge.expires_at < now_secs {
        return Err("Challenge expired".into());
    }

    // Step 4: Build partial transaction
    println!("Step 3: Building partial transaction...");
    let (partial_tx_hex, template_mode) =
        if let Some(ref tmpl) = challenge.template {
            if !tmpl.rawtx_hex.is_empty() {
                println!("  using Profile B (gateway template)");
                (tmpl.rawtx_hex.clone(), true)
            } else {
                println!("  using Profile A (open nonce)");
                let tx = build_unsigned_partial_tx(
                    &nonce.txid,
                    nonce.vout,
                    &challenge.payee_locking_script_hex,
                    challenge.amount_sats,
                )?;
                (tx, false)
            }
        } else {
            println!("  using Profile A (open nonce)");
            let tx = build_unsigned_partial_tx(
                &nonce.txid,
                nonce.vout,
                &challenge.payee_locking_script_hex,
                challenge.amount_sats,
            )?;
            (tx, false)
        };

    // Step 5: Submit to delegator
    println!("Step 4: Submitting to delegator...");
    let deleg_req = DelegationRequest {
        partial_tx: partial_tx_hex,
        challenge_hash: challenge_hash.clone(),
        payee_locking_script_hex: Some(challenge.payee_locking_script_hex.clone()),
        amount_sats: Some(challenge.amount_sats),
        nonce_outpoint: Some(NonceOutpoint {
            txid: nonce.txid.clone(),
            vout: nonce.vout,
            satoshis: Some(nonce.satoshis),
        }),
        template_mode: Some(template_mode),
    };

    let deleg_resp = client
        .post(format!("{}{}", delegator_url, delegator_path))
        .json(&deleg_req)
        .send()
        .await?;

    if !deleg_resp.status().is_success() {
        let status = deleg_resp.status();
        let body = deleg_resp.text().await?;
        return Err(format!("Delegator returned {}: {}", status, body).into());
    }

    let delegation: DelegationResult = deleg_resp.json().await?;
    let rawtx_hex = delegation
        .completed_tx
        .as_deref()
        .or(delegation.rawtx_hex.as_deref())
        .ok_or("Delegator response missing completed_tx/rawtx_hex")?;

    println!("  delegator returned txid={}", delegation.txid);

    // Step 6: Broadcast (in production, POST to WhatsOnChain or ARC)
    println!("Step 5: Broadcasting transaction...");
    // broadcast_tx(&rawtx_hex).await?;

    // Step 7: Build proof and retry
    println!("Step 6: Retrying with proof...");
    let parsed_url = url::Url::parse(&target_url)?;
    let rawtx_bytes = hex::decode(rawtx_hex)?;

    let proof = Proof {
        v: "1".into(),
        scheme: "bsv-tx-v1".into(),
        txid: delegation.txid.clone(),
        rawtx_b64: general_purpose::STANDARD.encode(&rawtx_bytes), // standard base64 with padding
        challenge_sha256: challenge_hash,
        request: RequestBinding {
            domain: parsed_url
                .host_str()
                .map(|h| {
                    if let Some(port) = parsed_url.port() {
                        format!("{}:{}", h, port)
                    } else {
                        h.to_string()
                    }
                })
                .unwrap_or_default(),
            method: "GET".into(),
            path: parsed_url.path().into(),
            query: parsed_url.query().unwrap_or("").into(),
            req_headers_sha256: challenge.req_headers_sha256.clone(),
            req_body_sha256: challenge.req_body_sha256.clone(),
        },
    };

    let proof_json = serde_json::to_string(&proof)?;
    // Outer encoding: base64url without padding
    let proof_header = general_purpose::URL_SAFE_NO_PAD.encode(proof_json.as_bytes());

    let retry_resp = client
        .get(&target_url)
        .header("X402-Proof", &proof_header)
        .send()
        .await?;

    println!("Step 7: Response status={}", retry_resp.status());
    if let Some(receipt) = retry_resp.headers().get("x402-receipt") {
        println!("  X402-Receipt: {}", receipt.to_str().unwrap_or(""));
    }
    if let Some(status) = retry_resp.headers().get("x402-status") {
        println!("  X402-Status: {}", status.to_str().unwrap_or(""));
    }
    println!("  Body: {}", retry_resp.text().await?);

    Ok(())
}
