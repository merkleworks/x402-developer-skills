skill:
  name: replay-protection
  category: protocol
  purpose: Describe how x402 achieves replay protection through UTXO single-spend, nonce lifecycle management, and request binding.
  when_to_use: When implementing nonce management, evaluating security properties, or debugging replay-related failures.
  inputs: None. This is a reference description.
  outputs: A complete technical description of the replay protection mechanism covering nonce lifecycle, attack cases, request binding, operational caching, atomic reservation, and mempool acceptance semantics.
  procedure:
    1. Define the nonce.
       The nonce is a 1-satoshi UTXO minted by the gatekeeper. It is referenced by its outpoint (txid:vout). The nonce serves as a cryptographic single-use token: because a UTXO can only be spent once (enforced by Bitcoin consensus), consuming the nonce in a payment transaction guarantees that the same nonce cannot be used in a second transaction.

       Protocol invariant: the nonce is ALWAYS gateway-issued. The client never supplies its own nonce. This prevents the client from controlling or bypassing the replay-protection mechanism. A client-supplied nonce would allow the client to choose an already-spent UTXO, a UTXO it controls, or a UTXO that does not exist in the gatekeeper's pool.

    2. Describe the nonce lifecycle.
       The nonce passes through the following states:

       Mint:
         The gatekeeper creates nonce UTXOs via a treasury fan-out transaction. A single treasury UTXO is split into many 1-sat outputs. Each output is a potential nonce. The fan-out transaction is broadcast and confirmed.

       Pool (available):
         Minted nonces reside in the nonce pool. They are unallocated and available for use in challenges. The pool is a finite resource that must be replenished before it is exhausted.

       Lease (with TTL):
         When a challenge is generated, a nonce is leased from the pool. The lease has a time-to-live (TTL) matching the challenge expiry. During the lease period, the nonce is reserved for this specific challenge and cannot be assigned to another challenge.

       Challenge:
         The leased nonce outpoint is embedded in the challenge JSON. The client receives the nonce outpoint as part of the 402 response.

       Spend:
         The client includes the nonce as input[0] of the payment transaction. When the transaction is broadcast and accepted into the mempool, the nonce UTXO is consumed. It can never be spent again.

       Mark spent:
         The gatekeeper records the nonce outpoint as spent in its operational state. This is a bookkeeping step, not a correctness requirement — the BSV network already prevents double-spend.

       Lease expiry:
         If the client does not complete the payment before the TTL expires, the lease lapses. The nonce returns to the pool (available state) and can be assigned to a future challenge. The gatekeeper must verify that the nonce is still unspent before re-leasing it.

    3. Explain UTXO single-use as the primary replay protection mechanism.
       The BSV network enforces that a UTXO can be spent exactly once. This is not a server-side check — it is a consensus rule enforced by every node. When the payment transaction consumes the nonce UTXO, no second transaction can consume the same UTXO. This means:
         - The same transaction cannot be accepted twice (identical txid, same inputs).
         - A different transaction referencing the same nonce input is rejected as a double-spend attempt.

       This property holds globally, across all nodes, without the gatekeeper needing to maintain replay state. The gatekeeper can crash, restart, and lose all in-memory state, and replay protection still holds because the BSV network remembers which UTXOs have been spent.

    4. Enumerate replay attack cases and their mitigations.

       Case 1 — Nonce already spent, same transaction re-presented.
         Attack: The attacker captures a valid proof (txid + rawtx) and replays the same HTTP request with the same proof.
         Mitigation at consensus layer: The transaction was already accepted. Re-broadcasting the same transaction is a no-op (the network already has it).
         Mitigation at gatekeeper layer: The gatekeeper may either:
           a. Idempotent re-serve: recognize the txid and serve the response again (useful for retries after network failures).
           b. Accept-once: reject the proof because the nonce_utxo is already in the spent set.
         The choice between (a) and (b) is an implementation decision. Both are safe because the payment was already settled.

       Case 2 — Same txid, different endpoint.
         Attack: The attacker takes a valid proof for endpoint A and presents it to endpoint B.
         Mitigation: The gatekeeper re-derives the challenge from the current request's binding fields (domain, method, path, query, headers hash, body hash). The re-derived challenge hash will differ from the original challenge hash because the path (and possibly other fields) differ. Proof verification fails at the challenge hash comparison step.

       Case 3 — New transaction without the challenge nonce.
         Attack: The attacker constructs a new transaction that pays the correct amount but uses a different UTXO as input[0] instead of the challenge nonce.
         Mitigation: The gatekeeper verifies that input[0] of the transaction references the nonce_utxo from the challenge. If it does not match, the proof is rejected.

       Case 4 — New transaction with a different nonce.
         Attack: The attacker obtains a nonce from a different challenge and constructs a transaction using that nonce.
         Mitigation: The gatekeeper re-derives the challenge from the current request. The nonce_utxo in the re-derived challenge is specific to the original 402 response. The attacker's transaction uses a different nonce, so the challenge hash does not match. Proof verification fails.

       Case 5 — Modified request body, same proof.
         Attack: The attacker changes the request body but presents the original proof.
         Mitigation: The gatekeeper computes req_body_sha256 from the actual request body. This hash is part of the challenge. When the gatekeeper re-derives the challenge, the body hash differs, producing a different challenge hash. Proof verification fails.

       Case 6 — Modified request headers, same proof.
         Attack: The attacker changes an allowlisted header but presents the original proof.
         Mitigation: The gatekeeper computes req_headers_sha256 from the actual request headers. This hash is part of the challenge. The re-derived challenge hash differs. Proof verification fails.

    5. Explain request binding as cross-endpoint replay prevention.
       The challenge hash includes domain, method, path, query, req_headers_sha256, and req_body_sha256. Any change to any of these fields produces a different challenge hash. This means a proof is valid only for the exact request it was generated for.

       Without request binding, an attacker could pay for a cheap endpoint and reuse the proof on an expensive endpoint. Request binding prevents this by making the challenge hash endpoint-specific and request-specific.

    6. Describe the operational replay cache.
       The gatekeeper maintains an LRU (Least Recently Used) map of nonce_utxo to txid. This cache serves as defence-in-depth:

       Purpose:
         - Fast rejection of re-presented proofs without querying the BSV network.
         - Idempotent re-serve: if the gatekeeper recognizes a nonce_utxo that was already accepted, it can serve the cached response without re-verifying the full transaction.

       Properties:
         - The cache is NOT correctness-critical. If the cache is lost (crash, restart, eviction), the gatekeeper falls back to verifying the transaction against the BSV network. The protocol remains secure.
         - The cache is bounded. LRU eviction prevents unbounded memory growth.
         - The cache key is the nonce_utxo outpoint (txid:vout string). The cache value is the accepted txid.

       Sizing guidance:
         - The cache should hold at least the number of nonces that could be in-flight (leased but not yet verified). A reasonable default is 10x the nonce pool size or 100,000 entries, whichever is larger.

    7. Describe atomic nonce reservation.
       When the gatekeeper generates a challenge, it must atomically reserve the nonce. The reservation sequence is:

       Step 7a — Select an available nonce from the pool.
       Step 7b — Atomically transition the nonce from "available" to "leased" with a TTL.
       Step 7c — Only after the nonce is successfully reserved, proceed to construct the challenge.

       If the reservation fails (pool exhausted, contention), the gatekeeper must return 503 (Service Unavailable) to the client, not a challenge with an invalid nonce.

       In Sponsored mode, the delegator must also atomically reserve fee UTXOs. The reservation order is:
         1. Reserve nonce (gatekeeper side, during challenge generation).
         2. Reserve fee UTXOs (delegator side, during delegation request).

       If fee UTXO reservation fails, the delegator returns an error. The nonce lease will eventually expire and the nonce returns to the pool.

       Concurrency hazard: if two threads attempt to lease the same nonce, exactly one must succeed and the other must fail. This requires either a lock, a compare-and-swap operation, or a serialized queue.

    8. Describe the mempool acceptance matrix.
       When the client broadcasts the completed transaction, the BSV network responds with one of the following:

       200 — Transaction accepted and visible in mempool.
         The transaction is valid and has been propagated. The client can proceed with the proof retry. The gatekeeper will be able to verify mempool visibility.

       202 — Transaction seen but pending.
         The transaction was received but has not yet propagated to all nodes. The client may proceed but should be prepared for the gatekeeper to not yet see the transaction. A short delay (1-2 seconds) or a retry with backoff may be necessary.

       409 — Double-spend detected.
         The nonce UTXO or a fee UTXO has already been spent by a different transaction. The payment transaction is invalid. The client must discard this proof and request a new challenge (start the 402 cycle over).

         Common causes:
           - Nonce lease expired and the nonce was re-leased to another client.
           - Fee UTXO was double-allocated by the delegator (indicates a delegator bug).
           - Network race condition between two transactions spending the same input.

       503 — Node error.
         The broadcast endpoint is temporarily unavailable. The client should retry the broadcast with exponential backoff. The nonce may still be valid if the TTL has not expired.

       The client must handle all four cases. Treating a 409 as a retriable error is incorrect — the transaction is permanently invalid and no amount of retrying will make it succeed.

  validation_rules:
    - Nonces MUST be gateway-issued. Client-supplied nonces violate the protocol.
    - Each nonce MUST be used in at most one challenge at a time (exclusive lease).
    - Nonce reservation MUST be atomic. Concurrent lease attempts for the same nonce MUST result in exactly one success.
    - Fee UTXO reservation at the delegator MUST be atomic.
    - The gatekeeper MUST re-derive the challenge from the actual HTTP request during proof verification. It MUST NOT trust nonce_utxo values from the proof without matching them against the expected challenge.
    - The operational replay cache is defence-in-depth. Loss of the cache MUST NOT cause the protocol to accept replayed proofs (the BSV network provides the ground truth).
    - A 409 broadcast response MUST cause the client to discard the proof and start a new 402 cycle. It MUST NOT be retried.
    - Expired nonce leases MUST return the nonce to the available pool only after verifying the nonce is still unspent on the network.

  common_errors:
    - Allowing client-supplied nonces. This breaks the replay protection model entirely. The client could supply an already-spent UTXO or a UTXO it controls.
    - Non-atomic nonce reservation. Without atomicity, two challenges can reference the same nonce. The first client to broadcast wins; the second gets a double-spend rejection.
    - Treating the replay cache as the source of truth. The cache is an optimization. The BSV network is the source of truth for UTXO spend status.
    - Retrying after a 409 broadcast response. A 409 means the transaction is permanently invalid. The client must request a new challenge.
    - Re-leasing an expired nonce without checking spend status. If the nonce was spent during the lease period (client broadcast just before expiry), re-leasing it produces an invalid challenge.
    - Omitting request binding fields from the challenge. Without binding, a proof for one endpoint can be replayed on a different endpoint.
    - Unbounded replay cache. Without LRU eviction or a size cap, the cache grows indefinitely, eventually consuming all available memory.
    - Not handling the 202 broadcast response. The client may need to wait briefly before the gatekeeper can verify mempool visibility. Proceeding immediately may cause a verification failure that is retriable.

  references:
    - x402 Protocol Specification (internal)
    - BSV consensus rules: UTXO single-spend enforcement
    - BSV mempool acceptance semantics
    - RFC 8785 (JSON Canonicalization Scheme) — for challenge hash computation referenced in binding
    - RFC 9110 Section 15.5.3 (HTTP 402 Payment Required)
    - RFC 9110 Section 15.6.4 (HTTP 503 Service Unavailable)
