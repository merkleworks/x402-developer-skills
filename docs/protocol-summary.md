# x402 Wire Format Quick Reference

Condensed reference for the x402 stateless settlement-gated HTTP protocol wire format.

## Protocol Stability

The x402 wire protocol defined in this repository is **frozen for v0.1**.

The following elements are considered stable and must remain backward compatible:

- challenge JSON structure  
- proof JSON structure  
- canonical challenge hashing rule  
- delegator request/response fields  
- HTTP status semantics  

**Challenge hashing rule:**

```
challenge_sha256 = SHA256(JCS(challenge))
```

Implementations must not use language-specific JSON serializers (e.g. `JSON.stringify()`).

Future protocol evolution must occur through versioned extensions rather than modification of existing fields.

---

## HTTP Headers

| Header | Direction | Encoding | Purpose |
|--------|-----------|----------|---------|
| `X402-Challenge` | Server -> Client | Base64url JSON | Challenge payload on 402 response |
| `X402-Proof` | Client -> Server | Base64url JSON | Payment proof on retry request |
| `X402-Accept` | Server -> Client | Comma-separated | Supported payment schemes |
| `X402-Receipt` | Server -> Client | Hex | SHA256(txid + ":" + challenge_sha256) |
| `X402-Status` | Server -> Client | Plain text | Mempool status: `accepted`, `pending`, `rejected`, `error` |

## Challenge JSON Schema

Returned in the `X402-Challenge` header (base64url-encoded).

```json
{
  "v": "1",
  "scheme": "bsv-tx-v1",
  "amount_sats": 1000,
  "payee_locking_script_hex": "76a914...88ac",
  "expires_at": 1700000000,
  "domain": "api.example.com",
  "method": "POST",
  "path": "/v1/resource",
  "query": "key=value",
  "req_headers_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "req_body_sha256": "abc123...",
  "nonce_utxo": {
    "txid": "abcdef...",
    "vout": 0,
    "satoshis": 1,
    "locking_script_hex": "76a914...88ac"
  },
  "template": {
    "rawtx_hex": "0100000001...",
    "price_sats": 1000
  },
  "require_mempool_accept": true,
  "confirmations_required": 0
}
```

### Challenge Field Reference

| Field | Type | JSON Key | Required | Description |
|-------|------|----------|----------|-------------|
| V | string | `v` | Yes | Protocol version. Value: `"1"` |
| Scheme | string | `scheme` | Yes | Payment scheme. Value: `"bsv-tx-v1"` |
| AmountSats | int64 | `amount_sats` | Yes | Payment amount in satoshis |
| PayeeLockingScriptHex | string | `payee_locking_script_hex` | Yes | Hex-encoded locking script for payee output |
| ExpiresAt | int64 | `expires_at` | Yes | Unix timestamp (seconds). Challenge invalid after this time |
| Domain | string | `domain` | Yes | Origin domain of the API endpoint |
| Method | string | `method` | Yes | HTTP method (uppercase): GET, POST, PUT, DELETE |
| Path | string | `path` | Yes | Request path including leading slash |
| Query | string | `query` | Yes | Query string without leading `?`. Empty string if none |
| ReqHeadersSHA256 | string | `req_headers_sha256` | Yes | SHA-256 hex of canonical request headers |
| ReqBodySHA256 | string | `req_body_sha256` | Yes | SHA-256 hex of raw request body bytes |
| NonceUTXO | NonceRef | `nonce_utxo` | No | Nonce UTXO for replay protection (Profile A) |
| Template | TemplateRef | `template` | No | Pre-built transaction template (Profile B only) |
| RequireMempoolAccept | bool | `require_mempool_accept` | Yes | Whether gateway checks mempool acceptance before returning 200 |
| ConfirmationsRequired | int | `confirmations_required` | Yes | Block confirmations required. 0 = mempool accepted is sufficient |

### NonceRef Fields

| Field | Type | JSON Key | Description |
|-------|------|----------|-------------|
| TxID | string | `txid` | Transaction ID of the nonce UTXO (hex) |
| Vout | uint32 | `vout` | Output index of the nonce UTXO |
| Satoshis | uint64 | `satoshis` | Satoshi value of the nonce UTXO |
| LockingScriptHex | string | `locking_script_hex` | Hex-encoded locking script of the nonce UTXO |

### TemplateRef Fields (Profile B)

| Field | Type | JSON Key | Description |
|-------|------|----------|-------------|
| RawTxHex | string | `rawtx_hex` | Hex-encoded partial transaction for client to sign |
| PriceSats | uint64 | `price_sats` | Price in satoshis for this template |

## Proof JSON Schema

Sent in the `X402-Proof` header (base64url-encoded).

```json
{
  "v": "1",
  "scheme": "bsv-tx-v1",
  "txid": "abcdef0123456789...",
  "rawtx_b64": "AQAAAAE...",
  "challenge_sha256": "def456...",
  "request": {
    "domain": "api.example.com",
    "method": "POST",
    "path": "/v1/resource",
    "query": "key=value",
    "req_headers_sha256": "e3b0c44...",
    "req_body_sha256": "abc123..."
  }
}
```

### Proof Field Reference

| Field | Type | JSON Key | Description |
|-------|------|----------|-------------|
| v | string | `v` | Protocol version. Value: `"1"` |
| scheme | string | `scheme` | Payment scheme. Value: `"bsv-tx-v1"` |
| txid | string | `txid` | Transaction ID (hex, 64 characters) |
| rawtx_b64 | string | `rawtx_b64` | Base64 standard encoding with padding of the signed raw transaction |
| challenge_sha256 | string | `challenge_sha256` | SHA-256 hex of the original challenge (JCS canonical) |
| request | object | `request` | Request binding fields (see below) |

### Proof Request Binding Fields

| Field | JSON Key | Description |
|-------|----------|-------------|
| domain | `domain` | Must match challenge domain |
| method | `method` | Must match challenge method |
| path | `path` | Must match challenge path |
| query | `query` | Must match challenge query |
| req_headers_sha256 | `req_headers_sha256` | Must match challenge req_headers_sha256 |
| req_body_sha256 | `req_body_sha256` | Must match challenge req_body_sha256 |

## Compact Proof Header

The proof may be sent using a compact prefix format:

```
v1.bsv-tx.<base64url-encoded-proof-json>
```

The gateway MUST accept both the raw base64url format and the compact prefix format.

## Optional Header: X402-Tx

In addition to `X402-Proof`, the client MAY send the raw transaction via:

```
X402-Tx: <base64-encoded raw transaction bytes>
```

Per the protocol spec, the value is **base64** (not hex). If present, the gateway MAY use it to skip base64 decoding of `rawtx_b64` from the proof body.

## Error Codes

### 400 Bad Request

| Code | Meaning |
|------|---------|
| `invalid_proof` | Proof JSON is malformed or fails structural validation |
| `invalid_partial_tx` | Transaction cannot be parsed or is structurally invalid |
| `invalid_sighash` | Transaction uses a disallowed sighash type |
| `invalid_version` | Protocol version in proof does not match |
| `invalid_scheme` | Payment scheme is not supported |
| `challenge_not_found` | Referenced challenge does not exist or has been evicted |
| `nonce_missing` | Challenge requires a nonce UTXO but none was consumed in the transaction |

### 402 Payment Required

| Code | Meaning |
|------|---------|
| `expired_challenge` | Challenge `expires_at` timestamp has passed |
| `insufficient_amount` | Transaction payment output is less than `amount_sats` |

### 403 Forbidden

| Code | Meaning |
|------|---------|
| `invalid_binding` | Proof request fields do not match the actual request |
| `invalid_payee` | Transaction does not pay to the required `payee_locking_script_hex` |

### 409 Conflict

| Code | Meaning |
|------|---------|
| `double_spend` | Nonce UTXO or payment input has already been spent |

### 202 Accepted

| Code | Meaning |
|------|---------|
| `payment_pending` | Transaction broadcast but not yet confirmed to required depth |

### 503 Service Unavailable

| Code | Meaning |
|------|---------|
| `no_utxos_available` | Nonce pool is exhausted; server cannot issue challenges |
| `mempool_check_error` | Mempool verification service is unreachable |

## Delegator Endpoints

The delegator accepts partial transactions at:

| Endpoint | Description |
|----------|-------------|
| `POST /delegate/x402` | Primary delegation endpoint |
| `POST /api/v1/tx` | Alternative endpoint (gateway compatibility) |

### Request Body (spec field names)

| Field | Type | Description |
|-------|------|-------------|
| `partial_tx` | string | Hex-encoded partial transaction |
| `challenge_sha256` | string | SHA-256 hex of the JCS-canonical challenge |
| `nonce_utxo` | object | Nonce UTXO reference (txid, vout, satoshis) |
| `payee_locking_script_hex` | string | Expected payee script |
| `amount_sats` | integer | Minimum required payment |
| `template_mode` | boolean | True for Profile B |

### Gateway Compatibility Aliases

Gateway implementations may accept these legacy field names:

| Spec Name | Alias |
|-----------|-------|
| `partial_tx` | `partial_tx_hex` |
| `challenge_sha256` | `challenge_hash` |
| `nonce_utxo` | `nonce_outpoint` |
| `rawtx` | `rawtx_hex`, `completed_tx` |

## Sighash Types

| Value | Name | Usage |
|-------|------|-------|
| `0x41` | ALL\|FORKID | Signs all inputs and outputs. Standard full commitment |
| `0xC1` | ALL\|ANYONECANPAY\|FORKID | Signs all outputs but only the signer's input. Used when delegator adds inputs |
| `0xC3` | SINGLE\|ANYONECANPAY\|FORKID | Signs only the corresponding output and the signer's input. Used for flexible transaction composition |

Gateway MUST reject any sighash type not in this set.

## Hash Computations

### Receipt Computation

```
receipt = SHA256(txid + ":" + challenge_sha256)
```

Where:
- `txid` is the hex-encoded transaction ID
- `challenge_sha256` is the SHA-256 hex of the JCS-canonical challenge JSON
- Concatenation is literal string concatenation with colon separator
- Result is hex-encoded

### Request Headers Hash

1. **Allowlist**: Only these headers are included in the hash:
   - `accept`
   - `content-type`
   - `content-length`
   - `x402-client`
   - `x402-idempotency-key`
2. **Lowercase** all header names
3. **Trim** leading and trailing whitespace from values
4. **Sort** lexicographically by header name
5. **Format** as `name:value\n` (newline-terminated, one per header)
6. **Hash**: SHA-256 of the resulting byte string
7. **Encode**: Hex-encoded result

Headers not in the allowlist are ignored. If no allowlisted headers are present, hash the empty string.

### Request Body Hash

```
body_hash = SHA256(raw_body_bytes)
```

If the request has no body (GET, DELETE, etc.):

```
body_hash = SHA256("")
```

`SHA256("")` = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

### Challenge Hash

1. Serialize the challenge JSON using **RFC 8785 JCS** (JSON Canonicalization Scheme)
2. Compute SHA-256 of the canonical JSON bytes
3. Hex-encode the result

**Rule:** `challenge_sha256 = SHA256(JCS(canonical_json(challenge)))`. Do NOT use `JSON.stringify()`; use a JCS implementation so that hashes are deterministic across languages. See `docs/canonical-hashing-test.md` for examples.

JCS rules:
- Object keys sorted lexicographically
- No whitespace
- Numbers serialized per ECMAScript rules
- No trailing commas
- UTF-8 encoding

## Proof Verification Order

Recommended order (cheapest first, matches gateway behavior):

1. **Cheap request validation** — Decode and parse proof; validate version and scheme (400 on failure).
2. **Challenge existence** — Lookup by `proof.challenge_sha256`; 400 if not found.
3. **Challenge expiry** — 402 if `expires_at <= now`.
4. **Canonical request binding** — Recompute and compare binding fields; 403 (invalid_binding) without revealing which field failed.
5. **Transaction structure** — Decode rawtx, verify txid, nonce spend, payee output.
6. **Mempool acceptance** — If required, query node; 200 / 202 / 409 as appropriate.
7. **Nonce consumption** — Replay cache update and nonce spend verification.
8. **Asset release** — Serve resource, return X402-Receipt and X402-Status.
