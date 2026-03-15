skill:
  name: validate-proof
  category: security
  purpose: Verify an X402-Proof header against the original challenge and the current request to confirm payment validity.
  when_to_use: When a client submits an X402-Proof header and the server must determine whether to grant access to the paid resource.
  inputs: The X402-Proof HTTP header value, the current HTTP request (method, host, path, query, headers, body), and the challenge cache containing issued challenges.
  outputs: A verdict (accept or reject) with a specific reason code if rejected.

  procedure:
    1. Decode the X402-Proof header value using base64url (RFC 4648 section 5, no padding) to obtain JSON bytes.
    2. Parse the JSON bytes into a proof object. Reject with 400 if parsing fails.
    3. Check proof.v equals "1". Reject with 400 unsupported_version if it does not.
    4. Check proof.scheme equals "bsv-tx-v1". Reject with 400 unsupported_scheme if it does not.
    5. Decode proof.rawtx_b64 using standard base64 (RFC 4648 section 4, with padding) to obtain raw transaction bytes. Reject with 400 if decoding fails.
    6. Compute the transaction ID.
       - SHA-256 hash the raw tx bytes.
       - SHA-256 hash the result (double SHA-256).
       - Reverse the byte order of the final hash.
       - Hex-encode to produce the txid string.
       - Compare to proof.txid using constant-time comparison. Reject with 400 txid_mismatch if they differ.
    7. Verify the transaction has at least one input. Reject with 400 no_inputs if the input count is zero.
    8. Look up the challenge in the challenge cache using proof.challenge_sha256 as the key. Reject with 400 challenge_not_found if absent.
    9. Check challenge expiry. If challenge.expires_at is less than or equal to the current unix timestamp, reject with 402 challenge_expired.
    10. Verify nonce spend.
        - The transaction must contain an input whose previous outpoint matches challenge.nonce_utxo (txid and vout).
        - For Profile B (template_mode): the nonce input must be at index 0.
        - Reject with 403 nonce_not_spent if no matching input is found.
    11. Verify request binding.
        - Recompute req_headers_sha256 from the current request using the header allowlist algorithm (see enforce-request-binding skill).
        - Recompute req_body_sha256 from the current request body.
        - Compare each to the values stored in the challenge.
        - Reject with 403 invalid_binding if any field mismatches.
    12. Verify payee output.
        - The transaction must contain an output whose locking script equals challenge.payee_locking_script_hex (exact hex comparison).
        - That output's satoshi value must be greater than or equal to challenge.amount_sats.
        - Reject with 402 insufficient_payment if no qualifying output is found.
    13. Enforce sighash types.
        - Profile A: every input's signature hash type must be 0xC1 or 0x41.
        - Profile B: input[0] must use 0xC3; all other inputs must use 0xC1 or 0x41.
        - Reject with 403 invalid_sighash if any input violates the policy.
    14. Check the replay cache for the nonce outpoint.
        - If the outpoint is already recorded with a different txid, reject with 409 double_spend.
        - If recorded with the same txid, this is an idempotent re-verification; proceed.
        - If not recorded, add it: nonce_utxo -> {txid, challenge_sha256, created_at}.
    15. Optional: if require_mempool_accept is enabled, query the BSV node mempool for proof.txid.
        - Visible and not double-spent: accept.
        - Not visible: respond 202 (pending, retry later).
        - Double-spend detected: reject with 409.

  validation_rules:
    - ALL string comparisons for txid, locking script hex, and challenge hash MUST use constant-time comparison (e.g., crypto/subtle.ConstantTimeCompare in Go, timingSafeEqual in Node.js). This prevents timing side-channel attacks.
    - Steps must be executed in order. Early rejection (e.g., at step 3) avoids unnecessary computation but must not leak information about later steps via timing.
    - The challenge cache lookup must be by challenge_sha256, not by any client-supplied identifier.
    - Nonce outpoints in the replay cache must persist at least until challenge.expires_at to prevent replay within the challenge window.
    - Never log raw private keys, full locking scripts, or raw transaction bytes at INFO level or above in production.

  common_errors:
    - Using standard base64 to decode the X402-Proof header. The header uses base64url (no padding). The rawtx_b64 field inside the proof uses standard base64 (with padding). Mixing these up causes decode failures.
    - Computing the txid without reversing byte order. Bitcoin txids are displayed in reverse byte order relative to the SHA-256d output.
    - Using non-constant-time string comparison for txid or script hex. This leaks information about partial matches via response timing.
    - Accepting a proof without checking challenge expiry. Expired challenges must be rejected even if the transaction is valid.
    - Skipping request binding verification. This allows a proof captured from one endpoint to be replayed against a different endpoint.

  references:
    - x402 protocol specification, proof format and verification flow.
    - RFC 4648, base64 and base64url encoding.
    - RFC 8785, JSON Canonicalization Scheme (JCS) for challenge hashing.
    - Bitcoin transaction serialization format and SHA-256d txid computation.
