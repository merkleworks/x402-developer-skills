# x402 Protocol Alignment Audit Report

**Scope:** `x402-developer-skills` vs. canonical protocol spec and `x402-gateway` reference implementation.  
**Authority order:** (1) Protocol spec → (2) Gateway implementation → (3) Developer skills.  
**Date:** 2026-03-15.

---

## SECTION 1 — Fully Aligned Components

The following are correctly aligned with the protocol spec and/or gateway:

| Component | Details |
|-----------|--------|
| **HTTP 402 challenge flow** | Skills describe: unpaid request → 402 + `X402-Challenge` / `X402-Accept` / `Cache-Control: no-store` → client builds partial tx → delegator → broadcast → retry with proof. Matches spec Steps 1–6. |
| **Challenge JSON structure** | `v`, `scheme` (bsv-tx-v1), `nonce_utxo` (txid, vout, satoshis, locking_script_hex), `amount_sats`, `payee_locking_script_hex`, `expires_at`, `domain`, `method`, `path`, `query`, `req_headers_sha256`, `req_body_sha256`, `require_mempool_accept`, `confirmations_required` — correctly documented in protocol-flow, protocol-summary, add-x402-to-http-api. |
| **Proof JSON structure** | `v`, `scheme`, `txid`, `rawtx_b64`, `challenge_sha256`, `request` (domain, method, path, query, req_headers_sha256, req_body_sha256) — matches spec and gateway `proof.go` / `types.go`. |
| **Nonce-as-UTXO replay model** | Nonce is gateway-issued 1-sat UTXO; single-spend at consensus; no client-supplied nonce. Correctly stated in replay-protection, explain-x402-protocol, protocol-flow. |
| **Request binding (RFC 8785)** | Header allowlist (accept, content-type, content-length, x402-client, x402-idempotency-key), lowercase names, trim/collapse whitespace, sort by name, `name:value\n`, SHA-256 → hex. Matches spec §3.1 and enforce-request-binding. |
| **Body hash** | `SHA256(raw_body_bytes)` → hex; empty body = `SHA256("")`. Documented correctly in protocol-summary, deterministic-binding, enforce-request-binding. |
| **Challenge hash** | JCS (RFC 8785) of challenge JSON, then SHA-256 → hex. Spec §3.3 and skills agree. |
| **Receipt computation** | `SHA256(txid + ":" + challenge_hash)` → hex. Protocol-summary and verify-payment-proof match spec. |
| **Sighash types** | 0x41 (ALL|FORKID), 0xC1 (ALL|ANYONECANPAY|FORKID) for fee inputs, 0xC3 (SINGLE|ANYONECANPAY|FORKID) for Profile B nonce. Protocol-summary and construct-payment-transaction align with spec and gateway. |
| **Delegator does not broadcast** | Client is responsible for broadcast; mempool check is gatekeeper’s responsibility. Stated in protocol-flow, run-delegator, explain-x402-protocol, and gateway PROTOCOL.md. |
| **Gateway endpoints** | `/delegate/x402` and `/api/v1/tx` documented; gateway api-reference and client-js/Postman use `POST /delegate/x402`. |
| **Error semantics (majority)** | 400 (invalid proof, challenge_not_found, etc.), 402 (expired_challenge, insufficient_amount), 403 (invalid_binding, invalid_payee), 409 (double_spend), 202 (pending), 503 (no_utxos_available, mempool_check_error) — protocol-summary and api-reference align with spec Acceptance Matrix. |
| **Atomic nonce reservation** | Spec “Atomic Nonce Reservation Precedes Economic Side Effects” and replay-protection step 7 / run-delegator ordering (reserve nonce then fee UTXOs) are aligned. |
| **Go client example** | Uses `partial_tx`, `challenge_hash`, `nonce_outpoint` for delegator request; accepts `completed_tx` or `rawtx_hex` in response; matches gateway client-js wire behavior. |

---

## SECTION 2 — Minor Drift / Naming Differences

| Location | Issue | Spec / Gateway | Suggested fix |
|----------|--------|----------------|----------------|
| **Delegator request: challenge field name** | Skills and Go example use `challenge_hash` in the request body. | Spec § Step 4: `challenge_sha256`. Gateway client-js sends `challenge_hash`. | Treat as alias: document that the delegator MAY accept `challenge_sha256` or `challenge_hash`; prefer `challenge_sha256` in docs to match spec. |
| **Delegator request: nonce field name** | run-delegator, implement-gateway, build-x402-client use `nonce_outpoint`. | Spec: `nonce_utxo` (object with txid, vout, satoshis, locking_script_hex). | Use `nonce_utxo` in all skill text and examples; reserve “nonce outpoint” for the derived key (e.g. `txid:vout` string) where appropriate. |
| **Delegator response: raw tx field** | Spec: `rawtx` (hex). Gateway client-js: `completed_tx` or `rawtx_hex`. run-delegator: `rawtx_hex`. | Gateway returns `rawtx` in Go `/api/v1/tx`; client-js expects `completed_tx` or `rawtx_hex` for `/delegate/x402`. | Document both: response MAY use `rawtx`, `rawtx_hex`, or `completed_tx`; clients should accept any of these for the completed transaction hex. |
| **Delegator request: partial tx field** | run-delegator, implement-gateway: `partial_tx_hex`. | Spec: `partial_tx`. Gateway client-js: `partial_tx`. | In skills, use `partial_tx` for the wire key (spec); note that the value is hex-encoded. |
| **protocol-summary X402-Receipt** | Describes receipt as “Hex”. | Spec: “X402-Receipt: &lt;hash&gt;”. | No change; “hex” is correct for the hash encoding. |

---

## SECTION 3 — Critical Protocol Mismatches

| File path | Location | Mismatch | Suggested fix |
|-----------|----------|----------|----------------|
| **skills/protocol/deterministic-binding.md** | Step 4a, example (lines ~72–110) | Challenge example uses `expiry_utc` (ISO 8601 string) and `nonce_outpoint` (string `"txid:vout"`). | Replace with spec fields: `expires_at` (Unix timestamp, number) and `nonce_utxo` (object: `txid`, `vout`, `satoshis`, `locking_script_hex`). Re-run JCS example with correct key set and types. |
| **skills/protocol/architecture-overview.md** | Challenge description | Text uses “nonce_outpoint” and “expiry_utc” in the challenge. | Use “nonce_utxo” and “expires_at” to match Protocol-Spec.md. |
| **skills/security/validate-proof.md** | Step 8, Step 9 | “Reject with 404 challenge_not_found” and “reject with 410 challenge_expired”. | Use **400** for challenge_not_found (spec and gateway api-reference: 400). Use **402 Payment Required** for expired challenge (spec Acceptance Matrix: “Expired challenge → 402 Payment Required”), not 410. |
| **skills/server/verify-payment-proof.md** | Step 13 (request binding) | “Include which field failed in the error response for debugging.” | Remove. Spec and enforce-request-binding require **not** revealing which binding field failed (security). Use generic 403 invalid_binding. |
| **skills/infrastructure/run-delegator.md** | Step 6 (Profile B sighash) | “input[0] must use 0xC3 (SIGHASH_ALL|ANYONECANPAY|FORKID with template flag)”. | 0xC3 is **SIGHASH_SINGLE** | ANYONECANPAY | FORKID. Replace with: “input[0] must use 0xC3 (SIGHASH_SINGLE|ANYONECANPAY|FORKID).” |

---

## SECTION 4 — Missing Protocol Coverage in the Skills

| Gap | Spec / gateway behavior | Recommendation |
|-----|--------------------------|----------------|
| **Compact proof header** | Spec: “X402-Proof: v1.bsv-tx.&lt;base64url(proof_json)&gt;”. Gateway proof.go supports this prefix. | Add to protocol-summary and protocol-flow: optional compact form and that server must accept both plain base64url JSON and `v1.bsv-tx.` prefix. |
| **X402-Tx header** | Spec Step 5: optional `X402-Tx: &lt;base64(rawtx)&gt;` when rawtx not embedded in proof. | Document in protocol-summary / protocol-flow as optional alternative to `rawtx_b64` in proof JSON. |
| **Two delegation endpoints** | Gateway exposes both `POST /delegate/x402` (binary partial_tx) and `POST /api/v1/tx` (JSON txJson). Go handler only implements `/api/v1/tx`. | Clarify in run-delegator and implement-gateway: `/delegate/x402` is the x402-spec endpoint (partial_tx hex); `/api/v1/tx` is an alternative JSON shape; document both request/response shapes. |
| **Verification order vs spec** | Spec Step 6 lists 16 verification steps in a specific order (e.g. request hashes before challenge_sha256, then domain/method/path/query, then expires_at, then txid/nonce/payee/mempool). | In verify-payment-proof, add a note that the implementation should follow the spec’s verification order where practical (e.g. early rejection on version/scheme/format, then binding, then challenge lookup and expiry, then tx structure and mempool). |
| **client_sig (v1.1)** | Spec defines optional `client_sig` (bip322-simple) in proof and Step 14. | Mention in protocol-summary and verify-payment-proof as optional v1.1; verification step “If signature enabled, verify client_sig”. |
| **Atomic nonce reservation (delegator)** | Spec “Atomic Nonce Reservation Precedes Economic Side Effects” applies to any component that reserves nonces (and fee UTXOs). | In run-delegator, explicitly state that the delegator must reserve fee UTXOs atomically before signing and that no economic side effects (e.g. leasing fee UTXOs) may occur before successful reservation. |

---

## SECTION 5 — Recommended Corrections (Checklist)

1. **deterministic-binding.md**  
   - Replace all challenge examples to use `expires_at` (number) and `nonce_utxo` (object).  
   - Remove `expiry_utc` and string `nonce_outpoint` from examples and procedure text.

2. **architecture-overview.md**  
   - Use “nonce_utxo” and “expires_at” in challenge field lists and descriptions.

3. **validate-proof.md**  
   - Change “404 challenge_not_found” → **400**.  
   - Change “410 challenge_expired” → **402 Payment Required**.

4. **verify-payment-proof.md**  
   - Remove “Include which field failed in the error response for debugging” for request binding failure.  
   - Specify generic 403 invalid_binding without revealing the failed field.

5. **run-delegator.md**  
   - Correct Profile B sighash for input[0] to “0xC3 (SIGHASH_SINGLE|ANYONECANPAY|FORKID)”.  
   - Use `partial_tx` (value hex) and `nonce_utxo` in request body description; document that response may use `rawtx`, `rawtx_hex`, or `completed_tx`.  
   - Add one sentence on atomic fee UTXO reservation before signing.

6. **protocol-summary.md / protocol-flow.md**  
   - Add optional compact header form `v1.bsv-tx.&lt;base64url&gt;` and optional `X402-Tx` header.  
   - Add brief note on optional `client_sig` (v1.1).

7. **implement-gateway.md / build-x402-client.md**  
   - Use `nonce_utxo` (and optionally `challenge_sha256`) in delegator request description for consistency with spec.

8. **Cross-reference spec**  
   - In skills that define wire format or verification, add a short line: “Normative wire contract: Protocol-Spec.md (01-protocol); in case of conflict, spec prevails.”

---

## Summary

- **Aligned:** Challenge/proof structure, nonce-as-UTXO, request binding (allowlist, JCS, hashes), receipt, sighash types, no-broadcast-by-delegator, error matrix (with exceptions below), and atomic nonce reservation concept.
- **Minor drift:** Delegator request/response field names (`challenge_hash` vs `challenge_sha256`, `nonce_outpoint` vs `nonce_utxo`, `partial_tx_hex` vs `partial_tx`, `rawtx_hex`/`completed_tx` vs `rawtx`). Resolve by standardizing on spec names in docs and allowing gateway aliases where needed.
- **Critical fixes:** deterministic-binding and architecture-overview (expiry_utc/nonce_outpoint → expires_at/nonce_utxo); validate-proof (404→400, 410→402); verify-payment-proof (do not reveal which binding field failed); run-delegator (0xC3 = SINGLE, not ALL; partial_tx/nonce_utxo; atomic reservation).
- **Coverage:** Document compact proof header, X402-Tx, two delegation endpoints, verification order, optional client_sig, and delegator atomic reservation.

Applying the corrections above will keep **x402-developer-skills** aligned with the canonical protocol spec and the x402-gateway reference implementation.
