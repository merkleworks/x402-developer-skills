skill:
  name: architecture-overview
  category: protocol
  purpose: Describe the 5-layer x402 architecture and the separation invariants between layers.
  when_to_use: When a developer needs to understand which component is responsible for what, and what each component must never do.
  inputs: None. This is a reference description.
  outputs: A detailed breakdown of each architectural layer, its responsibilities, its boundaries, and the invariants that enforce separation.
  procedure:
    1. Layer 0 — BSV Network.
       Role: Settlement finality and replay protection.
       Responsibilities:
         - UTXO single-spend enforcement. A UTXO can be consumed exactly once. Any attempt to spend it again is rejected as a double-spend.
         - Mempool acceptance. When a transaction is accepted into the mempool, it provides the first settlement signal. Miners include it in a block for finality.
         - Global replay protection. Because the nonce UTXO is consumed in the payment transaction, no second transaction can consume the same nonce. This is enforced by every node on the network, not by any single server.
       Does not:
         - Interpret HTTP semantics.
         - Know about challenges, proofs, or gatekeeper logic.

    2. Layer 1 — Fee Delegator.
       Role: Transaction completion and fee provision in Sponsored funding mode.
       Responsibilities:
         - Partial transaction validation. The delegator receives a partial transaction from the client and validates its structure: correct nonce input at index 0, payee output at index 0 with amount >= required, valid signatures on client inputs.
         - Fee UTXO lifecycle. The delegator manages a pool of fee-paying UTXOs. It fans out from a treasury UTXO to create small fee UTXOs, tracks their availability, and retires spent ones.
         - Transaction policy enforcement. The delegator enforces policy rules: maximum fee ceiling, allowed locking script types, maximum transaction size, maximum input/output count.
         - Fee input injection. The delegator appends one or more fee inputs to the partial transaction and signs them with SIGHASH_ALL|ANYONECANPAY (0xC1). This signature type commits to all outputs but allows other inputs to be present.
         - Returns completed transaction. The delegator returns {txid, rawtx_hex, accepted} to the client.
       Invariants:
         - NEVER broadcasts the transaction. The client is the sole broadcaster.
         - NEVER parses HTTP request content. The delegator has no knowledge of the HTTP request that triggered the payment. It receives only the partial transaction, challenge hash, payee locking script, amount, and nonce outpoint.
         - NEVER generates challenges. That is the gatekeeper's role.
         - NEVER verifies proofs against HTTP requests. That is the gatekeeper's role.
       Signing details:
         - Signs fee inputs with 0xC1 (SIGHASH_ALL|ANYONECANPAY).
         - 0xC1 means: "I commit to all outputs exactly as they are, but I allow additional inputs to exist." This prevents output tampering after the delegator signs while permitting the client to have already added its own inputs.

    3. Layer 2 — Gatekeeper.
       Role: HTTP-layer payment gate. Generates challenges, verifies proofs, gates responses.
       Responsibilities:
         - 402 challenge generation. When a request arrives without a valid X402-Proof header, the gatekeeper constructs a challenge JSON object containing: scheme, amount_sats, payee_locking_script_hex, nonce_utxo, expires_at, and request binding fields (domain, method, path, query, req_headers_sha256, req_body_sha256).
         - Request binding. The challenge cryptographically binds to the specific HTTP request by including deterministic hashes of the request headers and body. This prevents a proof generated for one request from being used on a different request.
         - Pricing. The gatekeeper determines the price for the requested resource (amount_sats). Pricing logic may be static, dynamic, or delegated to the service layer.
         - Proof verification. When a request arrives with an X402-Proof header, the gatekeeper executes the 16-step verification procedure to confirm the proof is valid, the transaction is broadcast, and the nonce is spent.
         - Response gating. If verification passes, the gatekeeper forwards the request to the service. If verification fails, the gatekeeper returns an appropriate error (402, 409, 400).
       Invariants:
         - NEVER signs transactions. The gatekeeper has no private keys.
         - NEVER holds private keys. Key material exists only at the delegator (fee keys) and the client (payment keys).
         - NEVER broadcasts transactions. The client broadcasts.
         - NEVER manages fee UTXOs. That is the delegator's role.
       Nonce management:
         - The gatekeeper mints nonce UTXOs (1-sat outputs from a treasury fan-out) and maintains a nonce pool.
         - Nonce lifecycle: mint -> pool (available) -> lease (with TTL) -> embed in challenge -> spend (consumed in payment tx) -> mark spent.

    4. Layer 3 — Service/API.
       Role: Business logic behind the payment gate.
       Responsibilities:
         - Implements the actual resource or computation that the client is paying for.
         - Receives requests only after the gatekeeper has verified the proof.
         - May provide pricing hints to the gatekeeper (e.g., per-resource pricing, dynamic pricing based on request parameters).
       Does not:
         - Handle payment logic.
         - Parse X402 headers.
         - Interact with the BSV network.
       Integration:
         - The gatekeeper sits in front of the service as middleware or a reverse proxy.
         - The service sees a normal HTTP request with additional metadata headers injected by the gatekeeper (e.g., the verified txid).

    5. Layer 4 — Commercial/Legal.
       Role: Business operations outside the protocol boundary.
       Responsibilities:
         - Billing reconciliation. Matching settled transactions to invoices, revenue reports, and payouts.
         - Service-level agreements. Uptime commitments, latency guarantees, dispute resolution.
         - Rate plans and pricing tiers. Business decisions that feed into the gatekeeper's pricing logic.
         - Compliance. Regulatory requirements that may constrain which transactions the delegator or gatekeeper accepts.
       Does not:
         - Participate in the real-time settlement flow.
         - Affect transaction validity.

    6. Summarize the separation of concerns.
       - Client: constructs transaction, signs payment inputs, broadcasts to BSV network, retries with proof.
       - Gatekeeper: issues challenges, verifies proofs, gates HTTP responses. No signing, no keys, no broadcast.
       - Delegator: validates partial tx, injects fee inputs, signs fee inputs (0xC1), returns completed tx. No broadcast, no HTTP parsing.
       - BSV Network: enforces UTXO single-spend. No HTTP awareness.
       - Service: business logic only. No payment awareness beyond receiving gated requests.

    7. Explain why separation matters.
       - Security isolation. Compromise of the gatekeeper does not yield private keys (it has none). Compromise of the delegator does not yield the ability to forge proofs (it does not verify them).
       - Auditability. Each layer has a narrow, well-defined responsibility. Auditing the delegator means auditing fee policy and signing logic. Auditing the gatekeeper means auditing challenge generation and proof verification.
       - Scalability. The gatekeeper is stateless (challenges are self-contained). Multiple gatekeeper instances can run behind a load balancer without shared state. The delegator manages UTXO state but does not need to scale with HTTP request volume (only with payment volume).
       - Replaceability. The delegator can be swapped without changing the gatekeeper. The gatekeeper can be swapped without changing the service.

  validation_rules:
    - The gatekeeper MUST NOT hold private keys or sign any transaction input.
    - The delegator MUST NOT broadcast transactions to the BSV network.
    - The delegator MUST NOT parse, inspect, or depend on HTTP request content.
    - The client MUST be the sole entity that broadcasts the completed transaction.
    - The delegator MUST sign fee inputs with SIGHASH_ALL|ANYONECANPAY (0xC1) only.
    - The gatekeeper MUST bind every challenge to the specific HTTP request via deterministic hashing.
    - Nonce UTXOs MUST be minted by the gatekeeper, never supplied by the client.
    - The service MUST NOT process requests that have not passed gatekeeper verification.

  common_errors:
    - Combining gatekeeper and delegator into a single component. This violates separation invariants and creates a single point of compromise that holds both keys and HTTP context.
    - Having the delegator broadcast. The delegator returns the completed transaction to the client. The client broadcasts.
    - Having the gatekeeper sign transactions. The gatekeeper has no keys. If you need the gatekeeper to "approve" a transaction, the mechanism is proof verification, not signing.
    - Assuming the delegator needs to know the HTTP request details. The delegator receives only: partial_tx, challenge_sha256, payee_locking_script_hex, amount_sats, nonce_utxo. Gateway implementations may accept legacy aliases (partial_tx_hex, challenge_hash, nonce_outpoint) for compatibility.
    - Treating Layer 4 (commercial) as part of the protocol. Billing and SLAs are out-of-band. They do not affect transaction validity or protocol correctness.
    - Scaling the delegator horizontally without coordinating UTXO state. Fee UTXOs are stateful resources. Concurrent delegator instances must coordinate to prevent double-allocation of fee UTXOs.

  references:
    - x402 Protocol Specification (internal)
    - BSV SIGHASH flag reference: 0x41 (ALL|FORKID), 0xC1 (ALL|ANYONECANPAY|FORKID), 0xC3 (SINGLE|ANYONECANPAY|FORKID)
    - RFC 9110 Section 15.5.3 (HTTP 402 Payment Required)
