skill:
  name: build-x402-client
  category: client
  purpose: Full procedure for building an x402 payment client from scratch, covering challenge detection through proof submission.
  when_to_use: When implementing a new x402 client without using the X402Client SDK, or when understanding the complete client-side payment flow at the protocol level.
  inputs: Target API URL, delegator URL, broadcast URL, BSV wallet or signing capability.
  outputs: A working x402 client that detects 402 challenges, delegates transaction signing, broadcasts transactions, and submits payment proofs to access protected resources.

  procedure:
    1. Send initial HTTP request to target API using standard HTTP methods (GET, POST, etc.).
    2. Detect HTTP 402 Payment Required status code in the response.
    3. Extract the X402-Challenge header value from the 402 response.
    4. Base64url decode the header value using RFC 4648 base64url alphabet with NO padding characters.
    5. Parse the decoded bytes as JSON to obtain the challenge object.
    6. Validate the challenge fields:
       - v must equal "1"
       - scheme must equal "bsv-tx-v1"
    7. Compute the challenge hash by taking SHA-256 of the decoded challenge bytes (the raw bytes BEFORE JSON parsing) and encoding the digest as lowercase hex.
    8. Check that expires_at (unix timestamp in seconds) is strictly greater than the current unix timestamp. Reject expired challenges immediately.
    9. Build the partial transaction based on the challenge profile:
       - Profile A (open nonce, no template field present):
         - Input[0]: spend the nonce_utxo identified by txid and vout from the challenge
         - Output[0]: pay to payee_locking_script_hex with value greater than or equal to amount_sats
       - Profile B (gateway template, template.rawtx_hex is present):
         - Use template.rawtx_hex directly as the base transaction
         - The gateway has already pre-signed input[0] with sighash 0xC3
         - Sponsor appends funding inputs and optional change outputs
    10. Submit the partial transaction to the delegator:
        - Endpoint: POST /delegate/x402
        - Request body (JSON):
          {
            "partial_tx_hex": "<hex-encoded partial transaction>",
            "challenge_sha256": "<hex from step 7>",
            "payee_locking_script_hex": "<from challenge>",
            "amount_sats": <from challenge>,
            "nonce_utxo": {
              "txid": "<nonce_utxo.txid>",
              "vout": <nonce_utxo.vout>,
              "satoshis": <nonce_utxo.satoshis>
            },
            "template_mode": <true if Profile B, false if Profile A>
          }
    11. Receive the delegation result:
        - Fields: txid, rawtx_hex, accepted (boolean)
        - Verify accepted is true before proceeding
    12. Broadcast the completed transaction to the BSV network. This is the client's responsibility, not the delegator's. Use the broadcast URL (default: WhatsOnChain mainnet broadcast endpoint).
    13. Build the proof JSON object:
        {
          "v": "1",
          "scheme": "bsv-tx-v1",
          "txid": "<txid from delegation result>",
          "rawtx_b64": "<standard base64 encoding of raw tx bytes WITH padding>",
          "challenge_sha256": "<challenge hash from step 7>",
          "request": {
            "domain": "<target API domain>",
            "method": "<HTTP method used>",
            "path": "<request path>",
            "query": "<query string or empty>",
            "req_headers_sha256": "<SHA-256 hex of bound request headers>",
            "req_body_sha256": "<SHA-256 hex of request body, or hash of empty string>"
          }
        }
    14. Base64url encode the proof JSON string using RFC 4648 base64url alphabet with NO padding.
    15. Retry the original HTTP request with the X402-Proof header set to the encoded proof value. All other request parameters (method, path, query, headers, body) must be identical to the original request.
    16. Handle the response status:
        - 200 OK: payment accepted, consume the protected resource
        - 202 Accepted: payment pending mempool confirmation, retry after a short delay
        - 409 Conflict: double-spend detected, obtain a new challenge and restart
        - 402 Payment Required: challenge expired or invalid, extract new challenge and restart from step 3

  validation_rules:
    - Never supply your own nonce UTXO. Always use the nonce_utxo provided by the gateway in the challenge.
    - Verify the delegator returned accepted=true before broadcasting. If accepted is false, do not broadcast.
    - rawtx_b64 in the proof must use standard base64 encoding (RFC 4648 section 4) WITH padding characters (=).
    - The outer proof encoding (X402-Proof header value) must use base64url encoding (RFC 4648 section 5) WITHOUT padding.
    - The challenge hash is computed from the raw decoded bytes, not from a re-serialized JSON string.
    - Do not cache or reuse challenges across different requests. Each 402 response issues a fresh challenge.
    - The request binding fields in the proof must exactly match the original request parameters.

  common_errors:
    - Confusing base64url (proof header encoding, challenge header encoding) with standard base64 (rawtx_b64 inside the proof body). These are different encodings.
    - Adding padding to base64url-encoded values. The x402 protocol uses unpadded base64url.
    - Computing the challenge hash from re-serialized JSON instead of the raw decoded bytes, producing a different hash.
    - Broadcasting before confirming accepted=true from the delegator.
    - Reusing a challenge after it has expired or after a 409 double-spend response.
    - Supplying a client-generated nonce UTXO instead of using the gateway-issued nonce.
    - Using base64url encoding for rawtx_b64 inside the proof object (it must be standard base64 with padding).

  references:
    - x402 Protocol Specification v1
    - RFC 4648 - The Base16, Base32, and Base64 Data Encodings
    - BSV transaction format specification
