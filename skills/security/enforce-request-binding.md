skill:
  name: enforce-request-binding
  category: security
  purpose: Bind each payment challenge to a specific HTTP request so that a proof for one request cannot be replayed against a different request.
  when_to_use: When issuing a 402 challenge (to embed binding fields) and when verifying a proof (to confirm the proof matches the current request).
  inputs: The HTTP request (method, host, path, query, headers, body) at challenge issuance time and again at proof verification time.
  outputs: A binding verdict — accept if all fields match, reject with 403 invalid_binding if any field mismatches.

  procedure:
    1. On challenge issuance — extract and embed binding fields.
       - domain: r.Host (includes port if non-standard).
       - method: r.Method (GET, POST, etc.).
       - path: r.URL.Path (e.g., /api/v1/resource).
       - query: r.URL.RawQuery (e.g., q=foo&limit=10). Empty string if no query.
       - req_headers_sha256: computed using the header allowlist algorithm (step 3).
       - req_body_sha256: SHA-256 of the raw request body bytes, hex-encoded. Empty body hashes to SHA-256 of empty bytes.
    2. On challenge issuance — compute challenge_sha256.
       - Serialize the complete challenge JSON using RFC 8785 JCS (JSON Canonicalization Scheme).
       - SHA-256 hash the canonical bytes.
       - Hex-encode the hash.
       - This single hash binds ALL challenge fields (including all binding fields) together. Tampering with any field invalidates the hash.
    3. Header allowlist algorithm for req_headers_sha256.
       - Allowlist: accept, content-type, content-length, x402-client, x402-idempotency-key.
       - For each header name in the allowlist:
         - If the header is present in the request, include it. If absent, omit it entirely (do not substitute an empty string).
       - Canonicalize each included header:
         - Lowercase the header name.
         - Trim leading and trailing whitespace from the value.
         - Collapse internal runs of whitespace to a single space.
       - Sort the included headers alphabetically by name.
       - Format as a single string: "name:value\n" for each header, concatenated.
       - SHA-256 hash the resulting string.
       - Hex-encode the hash.
    4. On proof verification — recompute binding fields from the current request.
       - Extract domain, method, path, and query from the current request using the same extraction logic as step 1.
       - Recompute req_headers_sha256 from the current request headers using the same allowlist algorithm as step 3.
       - Recompute req_body_sha256 from the current request body.
    5. On proof verification — compare each field to the stored challenge values.
       - Compare domain to challenge.domain.
       - Compare method to challenge.method.
       - Compare path to challenge.path.
       - Compare query to challenge.query.
       - Compare req_headers_sha256 to challenge.req_headers_sha256.
       - Compare req_body_sha256 to challenge.req_body_sha256.
       - If ANY field mismatches, reject with 403 invalid_binding. Do not reveal which field failed.
    6. All comparisons should use constant-time comparison to prevent timing-based information leakage about which field failed.

  validation_rules:
    - All six binding fields (domain, method, path, query, req_headers_sha256, req_body_sha256) must be checked. Skipping any field opens a replay vector for that dimension.
    - The header allowlist is fixed. Only the listed headers participate in the hash. Custom headers outside the allowlist are ignored.
    - Missing headers are omitted from the hash input, not represented as empty strings. This means a request with no Content-Type and a request with Content-Type: "" produce different hashes.
    - The challenge_sha256 (RFC 8785 JCS + SHA-256) is the integrity seal over the entire challenge. If any field is modified after issuance, the hash will not match the proof's challenge_sha256, and the challenge lookup in step 8 of validate-proof will fail.
    - The error response for binding failure must not specify which field mismatched. This prevents an attacker from iteratively correcting fields.

  common_errors:
    - Omitting query string comparison. This allows parameter substitution attacks: a proof for ?q=safe is accepted for ?q=dangerous.
    - Including all request headers in the hash instead of using the allowlist. This causes spurious binding failures when proxies add or modify headers (e.g., X-Forwarded-For, Via).
    - Representing missing headers as empty strings in the hash input. This conflates "header absent" with "header present but empty," creating a collision.
    - Not re-reading the request body for req_body_sha256 verification. Many HTTP frameworks consume the body stream on first read. The body must be buffered or re-readable.
    - Revealing which binding field failed in the error response. This helps an attacker incrementally fix a forged request to match the challenge.
    - Skipping request binding verification entirely and relying only on challenge_sha256. The challenge_sha256 binds the challenge fields to each other, but the server must still verify that the current request matches those fields.

  references:
    - x402 protocol specification, request binding and challenge integrity.
    - RFC 8785, JSON Canonicalization Scheme (JCS).
    - RFC 4648, base64url encoding used in the X402-Proof header.
    - OWASP guidelines on constant-time comparison for security-sensitive string operations.
