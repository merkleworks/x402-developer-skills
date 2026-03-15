"""
x402 Gateway Middleware Example (Python/Flask)

Demonstrates the server-side gatekeeper pattern:
- Issues 402 challenges for unauthenticated requests
- Verifies payment proofs on retry
- Gates access to protected endpoints
"""

import base64
import hashlib
import json
import os
import time
from functools import wraps
from typing import Any

from flask import Flask, Response, jsonify, request

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PAYEE_SCRIPT = os.getenv(
    "PAYEE_SCRIPT",
    "76a914000000000000000000000000000000000000000088ac",  # placeholder P2PKH
)
AMOUNT_SATS = int(os.getenv("AMOUNT_SATS", "100"))
CHALLENGE_TTL_SECS = int(os.getenv("CHALLENGE_TTL", "300"))

HEADER_ALLOWLIST = [
    "accept",
    "content-length",
    "content-type",
    "x402-client",
    "x402-idempotency-key",
]

# ---------------------------------------------------------------------------
# Challenge cache (in-memory, use Redis in production)
# ---------------------------------------------------------------------------

challenge_cache: dict[str, dict[str, Any]] = {}

# ---------------------------------------------------------------------------
# Hashing utilities
# ---------------------------------------------------------------------------


def sha256hex(data: bytes | str) -> str:
    """SHA-256 hex digest."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def hash_headers() -> str:
    """Hash request headers per x402 spec allowlist."""
    sorted_keys = sorted(HEADER_ALLOWLIST)
    parts = []

    for key in sorted_keys:
        value = request.headers.get(key, "")
        # Trim and collapse internal whitespace
        normalized = " ".join(value.split())
        parts.append(f"{key}:{normalized}")

    canonical = "\n".join(parts)
    if parts:
        canonical += "\n"

    return sha256hex(canonical)


def hash_body() -> str:
    """SHA-256 hex digest of request body."""
    body = request.get_data(as_text=True)
    return sha256hex(body)


# ---------------------------------------------------------------------------
# x402 Middleware
# ---------------------------------------------------------------------------


def x402_required(f):
    """Decorator that gates a Flask route behind x402 payment."""

    @wraps(f)
    def decorated(*args, **kwargs):
        proof_header = request.headers.get("X402-Proof")

        if not proof_header:
            return issue_challenge()

        result = verify_proof(proof_header)
        if isinstance(result, Response):
            return result

        # Proof valid — set receipt headers and call handler
        receipt_hash, status_val = result
        resp = f(*args, **kwargs)

        # If handler returned a dict, convert to Response
        if isinstance(resp, dict):
            resp = jsonify(resp)

        resp.headers["X402-Receipt"] = receipt_hash
        resp.headers["X402-Status"] = status_val
        return resp

    return decorated


def issue_challenge() -> Response:
    """Issue a 402 Payment Required response with challenge."""
    challenge = {
        "v": "1",
        "scheme": "bsv-tx-v1",
        "amount_sats": AMOUNT_SATS,
        "payee_locking_script_hex": PAYEE_SCRIPT,
        "expires_at": int(time.time()) + CHALLENGE_TTL_SECS,
        "domain": request.host,
        "method": request.method,
        "path": request.path,
        "query": request.query_string.decode("utf-8"),
        "req_headers_sha256": hash_headers(),
        "req_body_sha256": hash_body(),
        "require_mempool_accept": True,
        "confirmations_required": 0,
        # nonce_utxo would be leased from pool in production
    }

    challenge_json = json.dumps(challenge, separators=(",", ":"))
    challenge_bytes = challenge_json.encode("utf-8")
    challenge_hash = hashlib.sha256(challenge_bytes).hexdigest()

    challenge_cache[challenge_hash] = challenge

    encoded = base64.urlsafe_b64encode(challenge_bytes).rstrip(b"=").decode("ascii")

    resp = jsonify({
        "status": 402,
        "code": "payment_required",
        "message": "Payment required. See X402-Challenge header.",
    })
    resp.status_code = 402
    resp.headers["X402-Challenge"] = encoded
    resp.headers["X402-Accept"] = "bsv-tx-v1"
    resp.headers["Cache-Control"] = "no-store"
    return resp


def verify_proof(proof_header: str) -> tuple[str, str] | Response:
    """Verify a payment proof. Returns (receipt_hash, status) or error Response."""
    try:
        # base64url decode (add padding)
        padded = proof_header + "=" * (4 - len(proof_header) % 4)
        proof_bytes = base64.urlsafe_b64decode(padded)
        proof = json.loads(proof_bytes.decode("utf-8"))
    except Exception:
        return jsonify({"code": "invalid_proof", "message": "cannot decode proof"}), 400

    if proof.get("v") != "1" or proof.get("scheme") != "bsv-tx-v1":
        resp = jsonify({"code": "invalid_scheme", "message": "unsupported version or scheme"})
        resp.status_code = 400
        return resp

    challenge_sha256 = proof.get("challenge_sha256", "")
    challenge = challenge_cache.get(challenge_sha256)

    if not challenge:
        resp = jsonify({"code": "challenge_not_found", "message": "challenge not found or expired"})
        resp.status_code = 400
        return resp

    if challenge["expires_at"] <= int(time.time()):
        resp = jsonify({"code": "expired_challenge", "message": "challenge has expired"})
        resp.status_code = 402
        return resp

    # Verify request binding
    proof_req = proof.get("request", {})
    current_query = request.query_string.decode("utf-8")

    if (
        proof_req.get("domain") != request.host
        or proof_req.get("method") != request.method
        or proof_req.get("path") != request.path
        or proof_req.get("query", "") != current_query
    ):
        resp = jsonify({"code": "invalid_binding", "message": "request binding mismatch"})
        resp.status_code = 403
        return resp

    # In production: verify nonce spend, payee output, mempool acceptance
    # (see verify-payment-proof.md skill for complete 16-step verification)

    # Compute receipt: SHA256(txid + ":" + challenge_hash)
    txid = proof.get("txid", "")
    receipt_hash = sha256hex(f"{txid}:{challenge_sha256}")

    # Delete challenge (single-use)
    challenge_cache.pop(challenge_sha256, None)

    return receipt_hash, "accepted"


# ---------------------------------------------------------------------------
# Flask application
# ---------------------------------------------------------------------------

app = Flask(__name__)


@app.route("/v1/expensive")
@x402_required
def expensive_endpoint():
    """Protected endpoint requiring x402 payment."""
    return {
        "data": "premium content",
        "message": "Payment verified. Access granted.",
    }


@app.route("/health")
def health():
    """Health check (unprotected)."""
    return {"status": "ok"}


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8402"))
    print(f"x402 gateway listening on :{port}")
    app.run(host="0.0.0.0", port=port)
