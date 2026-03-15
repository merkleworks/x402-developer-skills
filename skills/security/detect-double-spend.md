skill:
  name: detect-double-spend
  category: security
  purpose: Detect and reject double-spend attempts across three defensive layers — consensus, replay cache, and mempool verification.
  when_to_use: When evaluating whether a submitted proof transaction is a legitimate first spend or an attempt to reuse a nonce outpoint that has already been consumed.
  inputs: The nonce outpoint (txid:vout) from the proof transaction, the spend txid, the challenge hash, and optional mempool query capability.
  outputs: A verdict — accept (first spend), idempotent (same txid retry), or reject (double-spend) — with the appropriate HTTP status code.

  procedure:
    1. Layer 1 — Consensus (passive, provided by the BSV network).
       - The Bitcoin UTXO model enforces single-use at the consensus level.
       - Any transaction attempting to spend an already-spent outpoint will be rejected by miners and nodes.
       - This is the ultimate guarantee. The operational layers below are defense-in-depth to provide fast rejection without waiting for on-chain confirmation.
    2. Layer 2 — Replay cache (operational, maintained by the gateway).
       - Data structure: LRU map keyed by nonce outpoint string ("txid:vout").
       - Value: {spendTxID, challengeHash, createdAt}.
       - On proof submission, look up the nonce outpoint in the cache.
       - Case A — Not found: this is a first spend. Record the entry and proceed to accept.
       - Case B — Found, same txid: this is an idempotent retry by the same client. Re-serve the resource (200 OK). Do not reject.
       - Case C — Found, different txid: this is a double-spend attempt. Reject immediately with 409 Conflict.
       - The txid comparison MUST use constant-time comparison to prevent timing side-channels.
    3. Layer 3 — Mempool acceptance (active, queries BSV node(s)).
       - Query the BSV node for transaction visibility: CheckMempool(txid).
       - Response fields: visible (bool), doubleSpend (bool), error (string or null).
       - Decision matrix:
         - visible=true, doubleSpend=false: transaction is accepted by the network. Return 200 OK.
         - visible=false, doubleSpend=false: transaction is not yet visible. Return 202 Accepted (client should retry).
         - doubleSpend=true (regardless of visible): a conflicting transaction exists. Return 409 Conflict.
         - error is non-null: mempool query failed. Return 503 Service Unavailable.
       - Two-node quorum (recommended for production):
         - Query two independent BSV nodes.
         - Accept only if both report visible=true and doubleSpend=false.
         - If either reports doubleSpend=true, reject.
         - This reduces the window for accepting a transaction that only one node has seen while the other has seen a conflicting spend.
    4. First-seen cache (optional, supplementary).
       - A lightweight cache mapping nonce_outpoint to txid with TTL = challenge.expires_at - current time.
       - Provides instant rejection of double-spends even before the mempool has propagated the first transaction.
       - If the first-seen cache entry exists and the txid differs, reject immediately without querying the mempool.

  validation_rules:
    - The replay cache is an operational aid, not a security guarantee. Correctness depends on UTXO single-use at the consensus layer. The system must remain correct even if the replay cache is entirely cleared or lost.
    - Constant-time comparison is required for all txid comparisons in the replay cache. Use crypto/subtle.ConstantTimeCompare (Go) or timingSafeEqual (Node.js).
    - The replay cache entry TTL must be at least as long as the challenge TTL. Entries expiring before the challenge window closes create a replay gap.
    - The two-node quorum must query genuinely independent nodes (different operators, different network paths). Two connections to the same node provide no additional safety.
    - A 202 Accepted response means the gateway has not yet confirmed mempool acceptance. The client must retry with the same proof. The server must not grant access until visibility is confirmed.

  common_errors:
    - Treating the replay cache as the sole double-spend defense and panicking when it is cleared. The consensus layer provides the actual guarantee; the cache provides fast operational rejection.
    - Using non-constant-time comparison for txid lookups. This leaks partial match information through response timing.
    - Setting replay cache TTL shorter than CHALLENGE_TTL. A nonce outpoint that expires from the cache before the challenge expires can be replayed within the remaining challenge window.
    - Querying a single mempool node and treating visible=true as definitive. A transaction may be visible to one node while a conflicting double-spend is visible to another. The two-node quorum mitigates this.
    - Rejecting an idempotent retry (same txid) as a double-spend. Clients may legitimately resubmit the same proof due to network errors. Same txid means same transaction; this is safe to re-serve.
    - Granting access on 202 Accepted without waiting for mempool confirmation. The 202 status means "pending," not "accepted."

  references:
    - x402 protocol specification, double-spend handling and replay cache requirements.
    - Bitcoin UTXO model and consensus rules for outpoint single-use.
    - BSV node RPC documentation for mempool query APIs.
