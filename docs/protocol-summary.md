# x402 Wire Format Quick Reference

Condensed reference for the x402 stateless settlement-gated HTTP protocol wire format.

## HTTP Headers

| Header | Direction | Encoding | Purpose |
|--------|-----------|----------|---------|
| `X402-Challenge` | Server -> Client | Base64url JSON | Challenge payload on 402 response |
| `X402-Proof` | Client -> Server | Base64url JSON | Payment proof on retry request |
| `X402-Accept` | Server -> Client | Comma-separated | Supported payment schemes |
| `X402-Receipt` | Server -> Client | Hex | SHA256(txid + ":" + challenge_hash) |
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
receipt = SHA256(txid + ":" + challenge_hash)
```

Where:
- `txid` is the hex-encoded transaction ID
- `challenge_hash` is the SHA-256 hex of the JCS-canonical challenge JSON
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

JCS rules:
- Object keys sorted lexicographically
- No whitespace
- Numbers serialized per ECMAScript rules
- No trailing commas
- UTF-8 encoding
