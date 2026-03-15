# Canonical Hashing Verification

## Purpose

Ensure `challenge_sha256` is computed identically across all implementations.

The challenge hash MUST be computed using RFC 8785 JSON Canonicalization Scheme (JCS).

```
challenge_sha256 = hex(SHA-256(JCS(challenge_json)))
```

This is NOT equivalent to:
```
SHA-256(JSON.stringify(challenge))
```

Standard JSON serializers do not guarantee key order or whitespace handling.
JCS enforces lexicographic key sorting, no whitespace, and deterministic number encoding.

## Algorithm

1. Construct the challenge JSON object with all fields.
2. Serialize using JCS (RFC 8785):
   - Sort object keys lexicographically by Unicode code point (recursive).
   - No whitespace between tokens.
   - Integers without decimal points or exponents.
   - Minimal string escaping.
3. Compute SHA-256 of the UTF-8 byte representation.
4. Encode the 32-byte digest as lowercase hexadecimal.

## Test Vector

Input challenge (pretty-printed):

```json
{
  "v": "1",
  "scheme": "bsv-tx-v1",
  "amount_sats": 100,
  "payee_locking_script_hex": "76a91489abcdefab012345678901234567890123456789088ac",
  "expires_at": 1742040300,
  "domain": "api.example.com",
  "method": "GET",
  "path": "/v1/resource",
  "query": "",
  "req_headers_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "req_body_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "nonce_utxo": {
    "txid": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "vout": 0,
    "satoshis": 1,
    "locking_script_hex": "76a91489abcdefab012345678901234567890123456789088ac"
  },
  "require_mempool_accept": true,
  "confirmations_required": 0
}
```

JCS canonical output (single line, keys sorted, no whitespace):

```
{"amount_sats":100,"confirmations_required":0,"domain":"api.example.com","expires_at":1742040300,"method":"GET","nonce_utxo":{"locking_script_hex":"76a91489abcdefab012345678901234567890123456789088ac","satoshis":1,"txid":"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2","vout":0},"path":"/v1/resource","payee_locking_script_hex":"76a91489abcdefab012345678901234567890123456789088ac","query":"","req_body_sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","req_headers_sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","require_mempool_accept":true,"scheme":"bsv-tx-v1","v":"1"}
```

## Implementation Examples

### Node.js

```javascript
const crypto = require("crypto");
const canonicalize = require("canonicalize"); // npm install canonicalize

const challenge = { /* challenge object */ };
const canonical = canonicalize(challenge);
const hash = crypto.createHash("sha256").update(canonical).digest("hex");
// hash === challenge_sha256
```

### Go

```go
import (
    "crypto/sha256"
    "encoding/hex"
    jcs "github.com/nicktrav/jcs-go" // or equivalent JCS library
)

canonical, _ := jcs.Marshal(challenge)
sum := sha256.Sum256(canonical)
hash := hex.EncodeToString(sum[:])
// hash == challenge_sha256
```

### Python

```python
import hashlib
import json
# pip install json-canonicalization
from json_canonicalization import canonicalize

canonical = canonicalize(challenge)
hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
# hash == challenge_sha256
```

### Rust

```rust
use sha2::{Sha256, Digest};
// Use serde_jcs or equivalent
let canonical = serde_jcs::to_string(&challenge).unwrap();
let hash = hex::encode(Sha256::digest(canonical.as_bytes()));
// hash == challenge_sha256
```

## Common Errors

- Using `JSON.stringify()` without JCS. Standard serializers do not sort keys.
- Sorting keys at the top level only. JCS requires recursive sorting (nested objects like `nonce_utxo` must also have sorted keys).
- Including whitespace. JCS output has zero whitespace between tokens.
- Encoding numbers as floats. `100` must serialize as `100`, not `100.0`.
- Using uppercase hex. The hash must be lowercase hexadecimal.

## References

- RFC 8785 — JSON Canonicalization Scheme (JCS)
- FIPS 180-4 — Secure Hash Standard (SHA-256)
- x402 Protocol Specification
