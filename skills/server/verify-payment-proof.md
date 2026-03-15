skill:
  name: verify-payment-proof
  category: server
  purpose: Complete 16-step payment proof verification procedure for x402 server-side gatekeeper middleware.
  when_to_use: When implementing the server-side proof verification logic that determines whether a client's payment is valid and the protected resource should be served.
  inputs: X402-Proof header value, original HTTP request (method, path, query, headers, body), challenge cache, replay cache, nonce pool, mempool checker.
  outputs: Verification result with HTTP status code (200, 202, 400, 402, 403, 409, 503) and corresponding X402-Status header value.

  procedure:
    1. Parse the proof: base64url decode (RFC 4648, no padding) the X402-Proof header value to obtain raw bytes, then parse as JSON.
    2. Validate version: proof.v must equal the string "1". If not, reject with 400 (unsupported_version).
    3. Validate scheme: proof.scheme must equal the string "bsv-tx-v1". If not, reject with 400 (unsupported_scheme).
    4. Decode the raw transaction: standard base64 decode (RFC 4648 section 4, WITH padding) proof.rawtx_b64 to obtain raw transaction bytes. Parse the bytes as a BSV transaction.
    5. Compute the txid from the raw transaction bytes:
       - Double SHA-256 of the serialized transaction
       - Reverse the resulting 32-byte hash to display order
       - Encode as lowercase hex
       - Constant-time compare the computed txid to proof.txid. Reject with 400 (txid_mismatch) if they differ.
    6. Verify the parsed transaction has at least 1 input. Reject with 400 (no_inputs) if empty.
    7. Lookup the original challenge from the challenge cache using proof.challenge_sha256 as the key.
    8. Replay check using the nonce outpoint (challenge.nonce_utxo.txid + ":" + challenge.nonce_utxo.vout) as the replay cache key:
       - If the nonce outpoint IS in the replay cache:
         a. If the cached txid matches proof.txid: this is an idempotent re-serve. Continue to step 16 (mempool check) to confirm the transaction is still valid.
         b. If the cached txid does NOT match proof.txid: reject with 409 (double_spend). A different transaction has already spent this nonce.
       - If the nonce outpoint is NOT in the replay cache: proceed to step 9.
    9. If the challenge was not found in the challenge cache (step 7 returned null): reject with 400 (challenge_not_found). The challenge may have expired and been evicted.
    10. Validate the challenge's own fields:
        - challenge.scheme must equal "bsv-tx-v1"
        - challenge.v must equal "1"
        Reject with 400 (invalid_challenge) if either fails.
    11. Check challenge expiry: challenge.expires_at must be strictly greater than the current unix timestamp (seconds). Reject with 402 (challenge_expired) if expired. The client must obtain a new challenge.
    12. Verify nonce spend: the parsed transaction must contain an input that spends the nonce UTXO identified by challenge.nonce_utxo.txid and challenge.nonce_utxo.vout.
        - Iterate transaction inputs and compare prevTxID (reversed to display order) and prevOutputIndex.
        - For Profile B (template mode): the nonce input must be at index 0 (input[0]).
        - Reject with 400 (nonce_not_spent) if no matching input is found.
    13. Verify request binding: compare the challenge's request binding fields to the current HTTP request:
        - domain: must match the Host header of the current request
        - method: must match the HTTP method of the current request (case-insensitive)
        - path: must match the request path of the current request
        - query: must match the query string of the current request
        - req_headers_sha256: compute SHA-256 hex of the current request's bound headers (using the same canonicalization and allowlist as challenge issuance) and compare
        - req_body_sha256: compute SHA-256 hex of the current request body and compare
        All comparisons must be exact string matches. Reject with 403 (request_binding_mismatch) if any field differs. Include which field failed in the error response for debugging.
    14. Verify payee output: the parsed transaction must contain an output that pays at least challenge.amount_sats to challenge.payee_locking_script_hex.
        - Iterate transaction outputs
        - For each output, compare the scriptPubKey (encoded as lowercase hex) to challenge.payee_locking_script_hex using constant-time comparison
        - If the script matches, verify the output value (satoshis) is greater than or equal to challenge.amount_sats
        - Reject with 400 (insufficient_payment) if no qualifying output is found
    15. Record in replay cache and update nonce pool:
        - Insert into replay cache: key = nonce outpoint string, value = { txid: proof.txid, challenge_hash: proof.challenge_sha256 }
        - Mark the nonce as spent in the nonce pool (transition from leased to spent)
    16. Mempool acceptance check: submit the raw transaction to the mempool checker (e.g., WhatsOnChain or local node) and interpret the result:
        - Transaction accepted to mempool (or already in mempool):
          - Compute receipt: SHA-256 of (proof.txid + ":" + proof.challenge_sha256), encoded as lowercase hex
          - Return 200 OK with headers:
            X402-Status: accepted
            X402-Receipt: <receipt hex>
          - Delete the challenge from the challenge cache
          - Serve the protected resource
        - Transaction pending (submitted but not yet confirmed in mempool):
          - Return 202 Accepted with header:
            X402-Status: pending
          - Do NOT serve the protected resource. The client should retry.
        - Transaction rejected (double-spend or invalid):
          - Return 409 Conflict with header:
            X402-Status: rejected
          - Do NOT serve the protected resource.
        - Mempool checker unavailable or error:
          - Return 503 Service Unavailable
          - Do NOT serve the protected resource.

  validation_rules:
    - All string comparisons for txid, script hex, and challenge hash MUST use constant-time comparison functions to prevent timing side-channel attacks. Do not use standard string equality (==).
    - The receipt is computed as SHA-256(txid + ":" + challenge_hash) where + is string concatenation. The input is the UTF-8 encoded string, not raw bytes of the txid.
    - rawtx_b64 uses standard base64 (with padding). The outer proof encoding uses base64url (without padding). Do not confuse these.
    - The challenge cache lookup (step 7) and replay check (step 8) must both be performed. The replay check handles the case where the challenge has been evicted but the nonce was already spent.
    - Step 15 (record in replay cache) must happen BEFORE step 16 (mempool check). This prevents a race condition where a second request with the same proof bypasses the replay check while the first is still checking mempool.
    - For idempotent re-serve (step 8a), the mempool check must still be performed. A previously accepted transaction may have been evicted from mempool.

  common_errors:
    - Using standard string equality instead of constant-time comparison for txid, script hex, and challenge hash. This leaks information about the expected values through timing differences.
    - Performing the mempool check before recording in the replay cache. This creates a TOCTOU race condition exploitable by concurrent duplicate requests.
    - Rejecting idempotent re-serves (same nonce, same txid) as double-spends. These should be allowed through to the mempool check.
    - Not checking challenge expiry (step 11) before verifying the transaction. Expired challenges should short-circuit to 402 without further processing.
    - Comparing scriptPubKey bytes directly instead of hex-encoded strings, or using different case (uppercase vs lowercase hex).
    - Computing the receipt incorrectly: the input to SHA-256 is the string "txid:challenge_hash", not binary concatenation of the two hashes.
    - Serving the protected resource on 202 (pending) responses. Only 200 (accepted) should serve the resource.
    - Not deleting the challenge from the cache after successful verification (step 16, accepted case). Stale challenges waste cache memory and could theoretically be reused if the replay cache is lost.

  references:
    - x402 Protocol Specification v1
    - RFC 4648 - The Base16, Base32, and Base64 Data Encodings
    - RFC 8785 - JSON Canonicalization Scheme (JCS)
    - Constant-time comparison: crypto.timingSafeEqual (Node.js), hmac.Equal (Go), or equivalent
