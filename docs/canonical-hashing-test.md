# Canonical Hashing for x402 Challenge Verification

This document defines how to compute `challenge_sha256` deterministically so that challenge hashing is identical across Node.js, Go, Python, and any other language. **Do not use `JSON.stringify()`** — it does not produce RFC 8785 JCS output and will cause cross-language verification failures.

## Rule

```
challenge_sha256 = SHA256( UTF-8( JCS(challenge) ) ) → lowercase hex
```

- **JCS** = RFC 8785 JSON Canonicalization Scheme: sort object keys lexicographically (recursively), no whitespace, deterministic number encoding, UTF-8.
- **SHA256** = Standard SHA-256 of the canonical JSON bytes.
- **Output** = 64-character lowercase hexadecimal string.

## Why Canonicalization Is Required

- **Cross-language verification:** A gatekeeper in Go must accept a proof whose `challenge_sha256` was computed by a client in Node.js or Python. Only JCS produces the same byte sequence for the same logical JSON.
- **Determinism:** Key order and number formatting differ between runtimes and libraries. Plain `JSON.stringify()` is not deterministic across languages or even across library versions.
- **Spec compliance:** The x402 protocol spec (01-protocol/Protocol-Spec.md) requires JCS for challenge hashing. Implementations that use non-JCS serialization are non-compliant.

## Node.js

Use an RFC 8785–compatible library (e.g. `canonicalize` or a JCS implementation). Do not use `JSON.stringify()` alone.

```javascript
const crypto = require("crypto");

// Example: using a JCS library (install e.g. canonical-json or similar)
function challengeSha256(challenge) {
  const canonical = canonicalize(challenge); // JCS: sorted keys, no whitespace
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex").toLowerCase();
}
```

If no JCS library is available, implement key sorting and compact serialization:

- Recursively sort object keys lexicographically.
- Serialize with no whitespace, no trailing commas, numbers as integers (no decimal point).
- UTF-8 encode the result, then SHA-256 and hex-encode (lowercase).

## Go

Use a JCS library or the same rules: sort keys, compact output, SHA-256.

```go
import (
    "crypto/sha256"
    "encoding/hex"
    "encoding/json"
)

// Use a JCS-compliant marshal (e.g. from a JCS package or custom key-sorted marshal).
func challengeSHA256(challenge interface{}) (string, error) {
    canonical, err := jcs.Marshal(challenge) // or custom JCS marshal
    if err != nil {
        return "", err
    }
    sum := sha256.Sum256(canonical)
    return hex.EncodeToString(sum[:]), nil
}
```

Ensure nested objects are also canonicalized (keys sorted recursively).

## Python

Use a JCS library or implement key-sorted, compact JSON and SHA-256.

```python
import hashlib
import json

def challenge_sha256(challenge):
    # Use a JCS library (e.g. jcs) or implement: sort keys recursively, no whitespace
    canonical = jcs.canonicalize(challenge)  # or custom canonicalize
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest().lower()
```

Custom canonicalization must: sort dict keys lexicographically, recurse into nested objects, output compact JSON (no spaces), integers without decimal point.

## Test Vectors

For the same challenge object, all three languages must produce the same `challenge_sha256`. Add a test that:

1. Builds a minimal challenge JSON (v, scheme, amount_sats, payee_locking_script_hex, expires_at, domain, method, path, query, req_headers_sha256, req_body_sha256, nonce_utxo object, require_mempool_accept, confirmations_required).
2. Canonicalizes with JCS in each language.
3. Computes SHA-256 and hex (lowercase).
4. Asserts that all three outputs are identical.

This guarantees that a client in one language and a gatekeeper in another will agree on challenge identity for proof verification.
