skill:
  name: deterministic-binding
  category: protocol
  purpose: Describe how x402 deterministically binds a challenge to a specific HTTP request and how challenge hashes are computed.
  when_to_use: When implementing challenge generation, proof verification, or any component that must produce or validate request binding hashes and challenge hashes.
  inputs: An HTTP request (method, domain, path, query, headers, body) and a challenge JSON object.
  outputs: req_headers_sha256, req_body_sha256, and challenge_sha256 — all as lowercase hex strings.
  procedure:
    1. Define the binding fields.
       Every x402 challenge contains the following request binding fields:
         - domain: the Host header value (lowercase, no port if default).
         - method: the HTTP method (uppercase, e.g., "GET", "POST").
         - path: the request path (e.g., "/api/v1/resource"). Must be normalized (no double slashes, no trailing slash unless root).
         - query: the query string without the leading "?". Empty string if no query. Parameters must be in their original order (do not sort).
         - req_headers_sha256: deterministic hash of selected request headers (see step 2).
         - req_body_sha256: SHA-256 of the raw request body bytes (see step 3).

       These fields are embedded directly in the challenge JSON. During proof verification, the gatekeeper re-derives these fields from the actual HTTP request and recomputes the challenge hash. If the recomputed hash does not match, the proof is rejected.

    2. Compute req_headers_sha256.
       This is the deterministic hash of a subset of request headers. The algorithm is:

       Step 2a — Apply the allowlist.
         Only the following headers are included:
           - accept
           - content-type
           - content-length
           - x402-client
           - x402-idempotency-key

         All other headers are ignored. If a listed header is absent from the request, it is simply omitted (not included as empty).

       Step 2b — Lowercase header names.
         Convert all header names to lowercase. Example: "Content-Type" becomes "content-type".

       Step 2c — Trim surrounding whitespace in values.
         Remove leading and trailing whitespace (spaces and tabs) from each header value. Example: "  application/json  " becomes "application/json".

       Step 2d — Collapse internal whitespace runs.
         Replace any sequence of one or more whitespace characters (spaces, tabs) within a header value with a single space. Example: "text/html,  application/json" becomes "text/html, application/json".

       Step 2e — Sort by header name.
         Sort the header entries lexicographically by their lowercase header name. Example: "accept" comes before "content-type".

       Step 2f — Join as "name:value\n" per header.
         Concatenate the entries. Each entry is formatted as:
           name:value\n
         where \n is a literal newline character (0x0A). There is no space after the colon. There is no trailing newline after the last entry — each entry ends with \n including the last one.

         Example for headers {content-type: application/json, accept: text/plain}:
           accept:text/plain\ncontent-type:application/json\n

       Step 2g — SHA-256 and hex-encode.
         Compute the SHA-256 hash of the UTF-8 encoded byte representation of the joined string. Encode the 32-byte hash as a 64-character lowercase hexadecimal string.

       Edge case: if no allowlisted headers are present in the request, the joined string is empty (""). The hash is SHA-256 of zero bytes: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.

    3. Compute req_body_sha256.
       Compute the SHA-256 hash of the raw request body bytes. Do not interpret, parse, or re-serialize the body. Hash the exact bytes received.

       Encode the 32-byte hash as a 64-character lowercase hexadecimal string.

       Edge case: for requests with no body (GET, HEAD, DELETE with no body), the body is the empty byte sequence. SHA-256 of the empty byte sequence is:
         e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855

       This value MUST be used explicitly. Do not omit the field or use null.

    4. Compute challenge_sha256.
       The challenge_sha256 is the SHA-256 of the JCS-canonicalized challenge JSON.

       Step 4a — Start with the challenge JSON object.
         The challenge JSON contains all fields: scheme, amount_sats, payee_locking_script_hex, nonce_utxo, expires_at, domain, method, path, query, req_headers_sha256, req_body_sha256.

       Step 4b — Apply RFC 8785 JSON Canonicalization Scheme (JCS).
         JCS defines a deterministic serialization of JSON. The rules are:

         Rule 1: Sort object keys lexicographically by their Unicode code points. This sort is applied recursively to nested objects.
           Example key order: "amount_sats" < "domain" < "expires_at" < "method" < ... < "scheme"

         Rule 2: No whitespace. No spaces or newlines between tokens. No space after colons or commas.
           Correct: {"amount_sats":1000,"domain":"api.example.com"}
           Wrong:   {"amount_sats": 1000, "domain": "api.example.com"}

         Rule 3: Deterministic number encoding. Integers are serialized without decimal points or exponents. 1000 is "1000", not "1e3" or "1000.0". Floating point numbers follow ECMAScript number-to-string rules (this protocol uses only integers for amount_sats, so floating point is not expected).

         Rule 4: Strings are serialized with minimal escaping. Only characters that MUST be escaped in JSON are escaped: quotation mark ("), reverse solidus (\), and control characters (U+0000 through U+001F).

         Rule 5: No BOM. No trailing newline.

       Step 4c — SHA-256 the UTF-8 bytes.
         Compute the SHA-256 hash of the UTF-8 byte representation of the JCS-canonicalized JSON string. Encode as a 64-character lowercase hexadecimal string.

       Example:
         Challenge JSON (pretty-printed for readability):
           {
             "scheme": "bsv-tx-v1",
             "amount_sats": 1000,
             "payee_locking_script_hex": "76a91489abcdefab012345678901234567890123456789088ac",
             "nonce_utxo": {"txid": "abcd1234...ef56", "vout": 0, "satoshis": 1, "locking_script_hex": "76a914...88ac"},
             "expires_at": 1742040300,
             "domain": "api.example.com",
             "method": "GET",
             "path": "/api/v1/resource",
             "query": "",
             "req_headers_sha256": "a1b2c3d4...64hex",
             "req_body_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
           }

         JCS-canonicalized (keys sorted, no whitespace):
           {"amount_sats":1000,"domain":"api.example.com","expires_at":1742040300,"method":"GET","nonce_utxo":{"locking_script_hex":"76a914...88ac","satoshis":1,"txid":"abcd1234...ef56","vout":0},"path":"/api/v1/resource","payee_locking_script_hex":"76a91489abcdefab012345678901234567890123456789088ac","query":"","req_body_sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","req_headers_sha256":"a1b2c3d4...64hex","scheme":"bsv-tx-v1"}

         challenge_sha256 = SHA-256(UTF-8 bytes of the above string) -> lowercase hex

    5. Explain why deterministic binding matters.

       Cross-language interoperability:
         JCS and the header hashing algorithm produce identical byte sequences regardless of programming language, JSON library, or platform. A challenge hash computed in Go must match one computed in TypeScript, Python, or Rust for the same input.

       Byte-stable verification:
         The gatekeeper re-derives the challenge from the incoming HTTP request during proof verification. If the serialization is not deterministic, the recomputed hash will differ from the original even for identical logical content. JCS eliminates this class of bugs.

       Request substitution prevention:
         Because the challenge hash includes the domain, method, path, query, header hash, and body hash, a proof generated for one request cannot be used for a different request. Changing any byte of the request changes the challenge hash, invalidating the proof.

       Header canonicalization rationale:
         The allowlist limits which headers affect the hash, preventing non-determinism from proxy-injected headers (X-Forwarded-For, Via, etc.). Whitespace normalization prevents mismatches caused by different HTTP libraries formatting header values differently.

  validation_rules:
    - The header allowlist MUST be exactly: accept, content-type, content-length, x402-client, x402-idempotency-key. No other headers are included.
    - Header names MUST be lowercased before hashing.
    - Header values MUST have surrounding whitespace trimmed and internal whitespace runs collapsed to a single space.
    - Headers MUST be sorted lexicographically by name.
    - The join format MUST be "name:value\n" with no space after the colon and a newline (0x0A) after each entry including the last.
    - Empty body MUST hash as SHA-256 of the empty byte sequence, not be omitted or null.
    - JCS canonicalization MUST sort keys lexicographically by Unicode code points, recursively.
    - JCS output MUST contain no whitespace between tokens.
    - Integers MUST be serialized without decimal points or exponents.
    - The challenge_sha256 MUST be the SHA-256 of the UTF-8 bytes of the JCS-canonicalized JSON, encoded as lowercase hex.
    - During proof verification, the gatekeeper MUST re-derive binding fields from the actual HTTP request. It MUST NOT use values supplied by the client.

  common_errors:
    - Sorting query parameters. Query parameters must remain in their original order. Do not sort them.
    - Including non-allowlisted headers. Only the five listed headers participate in the hash. Including others (e.g., Authorization, User-Agent) causes mismatches.
    - Forgetting to lowercase header names. "Content-Type" and "content-type" must both become "content-type".
    - Adding a space after the colon in header join format. The format is "name:value\n", not "name: value\n".
    - Omitting the trailing newline on the last header entry. Every entry ends with \n.
    - Using platform-specific newlines. The newline is 0x0A only. Not 0x0D 0x0A (CRLF).
    - Re-serializing the body before hashing. Hash the raw bytes exactly as received. Do not parse and re-serialize JSON bodies.
    - Using a non-JCS JSON serializer. Standard JSON.stringify (without a custom replacer and key sorting) does not produce JCS output. Use a dedicated JCS library or implement the sort-and-compact algorithm.
    - Serializing integers as floats. 1000 must be "1000", not "1000.0". Many JSON libraries default to float serialization.
    - Using uppercase hex. All hex-encoded hashes must be lowercase.
    - Omitting req_body_sha256 for bodiless requests. The field must be present with the hash of the empty byte sequence.

  references:
    - RFC 8785 — JSON Canonicalization Scheme (JCS)
    - RFC 9110 — HTTP Semantics (header field syntax)
    - FIPS 180-4 — Secure Hash Standard (SHA-256)
    - RFC 4648 Section 5 — base64url encoding
    - x402 Protocol Specification (internal)
