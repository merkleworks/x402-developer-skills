skill:
  name: implement-gateway
  category: server
  purpose: Full x402 gateway implementation covering all server-side components: gatekeeper, delegator, nonce pool, fee pool, treasury, and dashboard.
  when_to_use: When building a complete x402 gateway that issues challenges, delegates transaction signing, manages UTXO pools, and settles payments.
  inputs: BSV key material for nonce, fee, payee, and treasury pools; backend configuration (Redis or in-memory); HTTP server framework; protected API handlers.
  outputs: A running gateway that mediates x402 payments between clients and protected API endpoints.

  procedure:
    1. Generate or import separate BSV key pairs for each pool:
       - Nonce key: controls nonce UTXOs (1-sat outputs used in challenges)
       - Fee key: controls fee UTXOs (1-sat outputs used by the delegator to fund transaction fees)
       - Payee key: controls the payee locking script where payments are received
       - Treasury key: controls the funding wallet used for fan-out and sweep operations
       These MUST be separate keys. Sharing keys across pools creates signing conflicts and audit ambiguity.
    2. Initialize the nonce pool:
       - Backend: Redis (production) or in-memory map (development)
       - Pre-mint nonce UTXOs by fan-out from treasury (see step 7)
       - Each nonce is a 1-sat UTXO locked to the nonce key
       - Lifecycle states: available → leased → spent OR available → leased → reclaimed (on challenge expiry)
       - Lease a nonce when issuing a 402 challenge. Set lease TTL to match challenge TTL.
       - Reclaim leased nonces whose challenges expired without a valid proof.
       - Mark nonces as spent when a valid proof consumes them.
    3. Initialize the fee pool:
       - Separate pool of 1-sat UTXOs locked to the fee key
       - The delegator consumes fee UTXOs to add fee inputs to client transactions
       - Replenish by fan-out from treasury when pool runs low
    4. Implement the gatekeeper middleware:
       - Wrap protected HTTP handlers with x402 challenge/proof middleware
       - On request without proof: lease nonce, build challenge, return 402
       - On request with proof: verify proof, serve resource or return error
       - See add-x402-to-http-api skill for the full middleware procedure
    5. Implement the delegator endpoint:
       - Endpoint: POST /delegate/x402
       - Accept request body: { partial_tx_hex, challenge_hash, payee_locking_script_hex, amount_sats, nonce_outpoint, template_mode }
       - Validation:
         a. Verify challenge_hash exists in the challenge cache
         b. Verify nonce_outpoint matches the challenge's nonce_utxo
         c. Parse partial_tx_hex and verify it contains the nonce input and payee output
         d. Verify payee output pays at least amount_sats to payee_locking_script_hex
       - Transaction completion:
         a. Select a fee UTXO from the fee pool
         b. Append fee input to the transaction
         c. Sign the fee input with the fee key using sighash 0xC1
         d. If not template_mode: sign the nonce input with the nonce key using sighash 0xC1
         e. Compute the txid from the completed raw transaction
       - Return: { txid, rawtx_hex, accepted: true }
       - On any validation failure: return { accepted: false, error: "<reason>" }
    6. Profile B (template mode) support:
       - When the gateway issues a challenge, it may include a pre-signed template:
         a. Build a transaction with input[0] spending the nonce UTXO and output[0] paying the payee
         b. Sign input[0] with the nonce key using sighash 0xC3 (SIGHASH_SINGLE|ANYONECANPAY|FORKID)
         c. Include template.rawtx_hex in the challenge JSON
       - The delegator skips signing the nonce input for template_mode requests (already signed in step 6b)
       - The sponsor (client) appends funding inputs signed with 0xC1
    7. Implement treasury operations:
       - Fan-out: create pool UTXOs from a funding transaction
         a. Accept a funded UTXO from the treasury key
         b. Create a transaction with N outputs, each paying 1 sat to the target pool key (nonce or fee)
         c. Sign and broadcast
         d. Register the new UTXOs in the target pool
       - Sweep: consolidate settlement outputs
         a. Collect payee outputs from settled transactions
         b. Create a consolidation transaction sending total to the treasury address
         c. Sign and broadcast
       - Monitor pool levels and trigger fan-out when available count drops below threshold
    8. Implement the operational dashboard:
       - Nonce pool stats: total, available, leased, spent, reclaimed
       - Fee pool stats: total, available, consumed
       - Settlement revenue: total sats received, number of paid requests
       - Request metrics: 402 issued, proofs verified (accepted, rejected, pending), errors
       - Pool health alerts: low nonce count, low fee count, treasury balance

  validation_rules:
    - Nonce, fee, payee, and treasury keys must be distinct. Never reuse a key across pools.
    - The delegator must verify the partial transaction before signing. Never blind-sign a transaction from an untrusted client.
    - Fee UTXOs and nonce UTXOs are separate pools with separate keys. Do not mix them.
    - The nonce pool must enforce lease semantics. A leased nonce cannot be leased again until reclaimed or spent.
    - Fan-out transactions must be confirmed before registering the output UTXOs in the pool. Using unconfirmed fan-out outputs risks chain rejection if the fan-out transaction is dropped.
    - The delegator endpoint must be authenticated or rate-limited to prevent abuse.

  common_errors:
    - Using the same key for nonce and fee pools. This causes signing conflicts when the delegator tries to sign both inputs in the same transaction.
    - Not reclaiming expired nonce leases, leading to pool exhaustion under load.
    - Registering fan-out outputs in the pool before the fan-out transaction is confirmed. If the fan-out drops from mempool, all derived nonces become invalid.
    - Not authenticating the delegator endpoint. An unauthenticated delegator allows attackers to drain fee UTXOs.
    - Signing the nonce input in template_mode when it was already pre-signed by the gateway (double-signing invalidates the transaction).
    - Not monitoring pool levels. Running out of nonces causes 503 errors; running out of fee UTXOs causes delegation failures.

  references:
    - x402 Protocol Specification v1
    - BSV transaction construction and signing
    - Redis documentation (for production pool backend)
