# x402 Integration Guide

Step-by-step integration for server-side payment gating and client-side API consumption.

---

## Track A: Server-Side ("I want to charge for my API")

### Prerequisites

- BSV node access (or a broadcast/mempool-check endpoint)
- UTXO pool for nonce minting (Profile A replay protection)
- Private key controlling the payee locking script
- Go or Node.js runtime for gateway middleware

### Step 1: Add Gatekeeper Middleware

Insert the x402 gatekeeper as HTTP middleware in front of your protected routes. The gatekeeper intercepts requests and enforces the payment flow:

1. **No proof present**: Return HTTP 402 with `X402-Challenge` header
2. **Proof present**: Validate proof, verify transaction, execute handler if valid

The gatekeeper sits between the HTTP router and your application handlers. It does not modify request or response bodies for successful requests.

```
Client -> [Gatekeeper Middleware] -> [Your Handler]
                |
                v
          402 + Challenge (if no valid proof)
```

### Step 2: Configure Pricing

Define a pricing function that maps `(method, path, query)` to a satoshi amount. Options:

- **Static pricing**: Fixed amount per route
- **Dynamic pricing**: Amount varies by request parameters, time, load
- **Tiered pricing**: Different amounts for different API tiers

The pricing function is called when generating challenges. It must return an `int64` satoshi value.

### Step 3: Set Up Nonce Pool

For Profile A (nonce-based replay protection):

1. Fund a key with BSV
2. Split into small UTXOs (1 sat each recommended)
3. Configure the nonce mint to monitor pool depth and replenish automatically
4. Set minimum pool threshold (e.g., 100 UTXOs minimum)

Each challenge consumes one nonce UTXO. The nonce is spent in the payment transaction, providing consensus-layer replay protection.

### Step 4: Configure the Delegator

The delegator adds funding inputs to partial transactions. Configure:

- **Fee cap**: Maximum satoshis the delegator will add for fees (prevents abuse)
- **UTXO source**: Wallet or UTXO pool the delegator draws from
- **Allowed sighash types**: Restrict to `0x41`, `0xC1`, `0xC3`
- **Broadcast endpoint**: Where to submit completed transactions

### Step 5: Configure Challenge Parameters

| Parameter | Recommended | Description |
|-----------|-------------|-------------|
| Payee locking script | P2PKH or custom | Hex-encoded script receiving payment |
| Challenge TTL | 30-120 seconds | `expires_at` offset from issuance time |
| `require_mempool_accept` | `true` for production | Block on mempool acceptance before returning 200 |
| `confirmations_required` | `0` for low-value, `1+` for high-value | Block depth required |

### Step 6: Test with a Client

Use a reference client or `curl` to verify the flow:

1. Send request without proof -> expect 402 + challenge
2. Parse challenge from `X402-Challenge` header (base64url decode)
3. Build and sign transaction paying the challenge
4. Retry request with `X402-Proof` header -> expect 200 + `X402-Receipt`

---

## Track B: Client-Side ("I want to call an x402 API")

### Prerequisites

- Delegator URL (or local UTXO wallet for self-funding)
- BSV broadcast endpoint
- Private key for signing transaction inputs

### Step 1: Make the Initial Request

Send a standard HTTP request to the x402-gated endpoint. Include any required headers (`Content-Type`, `Accept`, etc.).

### Step 2: Handle the 402 Response

If the server returns HTTP 402:

1. Read the `X402-Challenge` header
2. Base64url-decode the value
3. Parse the resulting JSON as a Challenge object

### Step 3: Parse and Validate the Challenge

Before building a transaction, validate:

- `v` is `"1"`
- `scheme` is `"bsv-tx-v1"`
- `expires_at` is in the future (with clock skew tolerance)
- `amount_sats` is within your acceptable range
- `domain` matches the server you intended to call
- `method`, `path`, `query` match your original request

Reject the challenge if any validation fails. Do not build a transaction for a challenge you cannot verify.

### Step 4: Compute Request Binding Hashes

Compute the header and body hashes for your original request:

- **Headers hash**: Allowlist filter -> lowercase -> trim -> sort -> format `name:value\n` -> SHA-256 -> hex
- **Body hash**: SHA-256 of raw body bytes (or SHA-256 of empty string if no body)

Verify these match the challenge values. If they do not match, the server has issued an inconsistent challenge.

### Step 5: Build the Payment Transaction

Construct a BSV transaction that:

1. **Spends the nonce UTXO** (if `nonce_utxo` is present in the challenge)
2. **Includes a payment output** to `payee_locking_script_hex` for at least `amount_sats`
3. **Signs inputs** with an allowed sighash type (`0x41`, `0xC1`, or `0xC3`)

If using a delegator (partial signing):
- Build a partial transaction with the nonce input and payment output
- Sign your inputs with `ANYONECANPAY` sighash (`0xC1` or `0xC3`)
- Send to delegator to add funding inputs and change output
- Delegator returns the completed, fully-signed transaction

If self-funding:
- Add your own funding inputs
- Add payment output and change output
- Sign all inputs with `0x41` (ALL|FORKID)

### Step 6: Broadcast the Transaction

Submit the signed transaction to the BSV network via your broadcast endpoint. Record the `txid`.

### Step 7: Construct and Send the Proof

Build the proof JSON:

```json
{
  "v": "1",
  "scheme": "bsv-tx-v1",
  "txid": "<hex txid>",
  "rawtx_b64": "<base64 standard encoding of raw tx bytes>",
  "challenge_sha256": "<SHA-256 hex of JCS-canonical challenge JSON>",
  "request": {
    "domain": "<challenge domain>",
    "method": "<challenge method>",
    "path": "<challenge path>",
    "query": "<challenge query>",
    "req_headers_sha256": "<computed headers hash>",
    "req_body_sha256": "<computed body hash>"
  }
}
```

Base64url-encode the proof JSON. Retry the original request with the `X402-Proof` header set to the encoded value.

### Step 8: Process the Response

On success:
- HTTP 200 with the API response body
- `X402-Receipt` header contains `SHA256(txid + ":" + challenge_hash)`
- `X402-Status` header indicates mempool/confirmation status

On failure:
- Check the HTTP status code and error body against the error code table
- Common issues: expired challenge (retry from step 1), double spend (new nonce needed), insufficient amount

### Using the SDK: Drop-in Client

For supported languages, the SDK wraps the entire flow:

```typescript
import { X402Client } from "@x402/client";

const client = new X402Client({
  delegatorUrl: "https://delegator.example.com",
  privateKey: "<your-private-key-wif>",
});

// Drop-in replacement for fetch()
const response = await client.fetch("https://api.example.com/v1/resource", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ key: "value" }),
});
```

`X402Client.fetch()` handles challenge detection, transaction construction, delegation, broadcast, proof submission, and retry automatically.

---

## Production Checklist

### Nonce Pool Management

- [ ] Monitor nonce pool depth with alerting (alert when below threshold)
- [ ] Configure automatic replenishment (split transactions to refill pool)
- [ ] Set minimum pool size to handle peak request volume for at least 10 minutes
- [ ] Monitor for stuck/unconfirmed replenishment transactions

### Delegator Configuration

- [ ] Set fee cap to prevent excessive fee drain (e.g., max 500 sats per delegation)
- [ ] Configure UTXO consolidation schedule for the delegator wallet
- [ ] Monitor delegator wallet balance with alerting
- [ ] Rate limit delegation requests per client key

### Replay and Double-Spend Protection

- [ ] Enable replay cache to reject duplicate `challenge_sha256` values
- [ ] Set replay cache TTL to match or exceed challenge TTL
- [ ] Verify nonce UTXO is consumed in the submitted transaction
- [ ] Log all double-spend rejections for operational analysis

### Mempool and Broadcast

- [ ] Configure mempool checker endpoint (BSV node or third-party service)
- [ ] Set `require_mempool_accept: true` for production deployments
- [ ] Handle mempool checker unavailability gracefully (503 with `mempool_check_error`)
- [ ] Monitor broadcast success rate

### Challenge Configuration

- [ ] Set challenge TTL appropriate for your use case (30s for interactive, 120s for batch)
- [ ] Verify `domain` is set correctly (must match the public-facing hostname)
- [ ] For high-value endpoints, set `confirmations_required >= 1`
- [ ] Validate payee locking script is correct before deployment

### Rate Limiting and Abuse Prevention

- [ ] Rate limit 402 challenge issuance per source IP
- [ ] Rate limit proof submissions per source IP
- [ ] Monitor for challenge harvesting patterns (many 402s, no proofs)
- [ ] Set maximum request body size to prevent hash computation abuse
