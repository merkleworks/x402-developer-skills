skill:
  name: add-x402-to-http-api
  category: server
  purpose: HTTP middleware pattern for adding x402 payment gating to any HTTP API endpoint.
  when_to_use: When protecting an existing HTTP API with x402 payment requirements, or when implementing the server-side challenge/verify flow as middleware.
  inputs: Payee locking script hex, pricing function, nonce pool, challenge cache, replay cache, mempool checker, challenge TTL, bound headers allowlist.
  outputs: Middleware that intercepts requests, issues 402 challenges to unpaid requests, and verifies payment proofs on paid requests.

  procedure:
    1. Intercept incoming HTTP requests before they reach the application handler.
    2. Check for the presence of the X402-Proof header on the request.
    3. If X402-Proof is ABSENT, issue a 402 challenge:
       a. Call the pricing function to determine amount_sats for this endpoint. The pricing function receives the request (method, path, query, headers) and returns the price in satoshis.
       b. Lease a nonce UTXO from the nonce pool. The nonce is a pre-minted 1-sat UTXO that binds the challenge to a specific on-chain outpoint. If the pool is exhausted, return 503 Service Unavailable.
       c. Build the challenge JSON object:
          {
            "v": "1",
            "scheme": "bsv-tx-v1",
            "amount_sats": <price>,
            "payee_locking_script_hex": "<payee script hex>",
            "expires_at": <current unix timestamp + challenge TTL>,
            "domain": "<request host>",
            "method": "<request method>",
            "path": "<request path>",
            "query": "<request query string or empty>",
            "req_headers_sha256": "<SHA-256 hex of canonicalized bound headers>",
            "req_body_sha256": "<SHA-256 hex of request body>",
            "nonce_utxo": { "txid": "<nonce txid>", "vout": <nonce vout>, "satoshis": <nonce satoshis> },
            "require_mempool_accept": true,
            "confirmations_required": 0
          }
       d. Compute the challenge hash:
          - Serialize the challenge JSON using RFC 8785 JSON Canonicalization Scheme (JCS)
          - Compute SHA-256 of the canonical bytes
          - Encode the digest as lowercase hex
       e. Store the challenge in the challenge cache, keyed by the challenge hash. Set TTL to match expires_at.
       f. Base64url encode the challenge JSON (RFC 4648, no padding) and set the X402-Challenge response header.
       g. Return HTTP 402 Payment Required with Cache-Control: no-store header. The response body may contain a human-readable explanation but is not machine-parsed.
    4. If X402-Proof IS present, verify the payment proof. Delegate to the verify-payment-proof procedure (see verify-payment-proof skill).
    5. If the proof is valid and payment is accepted (verification returns 200):
       - Pass the request to the next handler (application logic)
       - Include X402-Status: accepted and X402-Receipt headers in the response
    6. If the proof is invalid or payment is not accepted, return the appropriate error:
       - 400 Bad Request: malformed proof, missing fields, challenge_not_found
       - 402 Payment Required: challenge expired, issue a new challenge (restart from step 3a)
       - 403 Forbidden: request binding mismatch (domain, method, path, query, headers, or body do not match)
       - 409 Conflict: double-spend detected (nonce already spent with a different txid)
       - 503 Service Unavailable: mempool checker unavailable or nonce pool exhausted

  validation_rules:
    - The challenge hash MUST be computed using JCS (RFC 8785) canonicalization, not from the raw JSON string. This ensures deterministic hashing regardless of key order or whitespace.
    - Cache-Control: no-store is mandatory on 402 responses to prevent intermediaries from caching challenges.
    - Nonce UTXOs must be leased (reserved) when included in a challenge, and reclaimed if the challenge expires without a valid proof.
    - The bound headers allowlist (BindHeaders config) determines which request headers are included in req_headers_sha256. Default: Authorization, Content-Type. Headers not in the allowlist are excluded from binding.
    - req_body_sha256 is the SHA-256 hex of the raw request body bytes. For requests with no body, it is the SHA-256 hex of the empty string.
    - Each challenge must be single-use. After successful verification, delete the challenge from the cache.

  common_errors:
    - Computing the challenge hash from non-canonical JSON. Different serialization order or whitespace produces a different hash, causing proof verification to fail.
    - Forgetting Cache-Control: no-store on the 402 response, allowing CDNs or proxies to cache and replay stale challenges.
    - Not leasing nonces before including them in challenges, allowing two concurrent challenges to reference the same nonce.
    - Including all request headers in the binding instead of only the allowlisted headers. Clients cannot reproduce the hash if unexpected headers are bound.
    - Not reclaiming nonces from expired challenges, causing pool exhaustion over time.
    - Returning 403 instead of 402 when the challenge has expired. Expired challenges should trigger a new challenge, not a permanent rejection.

  references:
    - x402 Protocol Specification v1
    - RFC 8785 - JSON Canonicalization Scheme (JCS)
    - RFC 4648 - The Base16, Base32, and Base64 Data Encodings
    - RFC 7234 - HTTP Caching (Cache-Control: no-store)
