skill:
  name: run-x402-gateway
  category: infrastructure
  purpose: Deploy and operate an x402 payment gateway with UTXO pool management and monitoring.
  when_to_use: When standing up a new x402 gateway instance for development or production, or when troubleshooting an existing deployment.
  inputs: BSV private keys (WIF format) for payee, nonce pool, and fee pool; network selection (mainnet/testnet); optional Redis URL for persistent pool storage.
  outputs: A running gateway process serving the x402 protocol on the configured listen address, with seeded UTXO pools and health monitoring.

  procedure:
    1. Generate WIF keys for each pool role using the keygen utility.
       - PAYEE_WIF — receives payment outputs from settled transactions.
       - NONCE_WIF — owns the 1-sat UTXOs used as challenge nonces.
       - FEE_WIF — owns the 1-sat UTXOs used by the delegator to cover tx fees.
    2. Set environment variables.
       - PAYEE_WIF — payee private key (required).
       - NONCE_WIF — nonce pool private key (required).
       - FEE_WIF — fee pool private key (required).
       - REDIS_URL — Redis connection string (optional; omit for in-memory pools).
       - CHALLENGE_TTL — challenge lifetime in seconds (default 300).
       - TEMPLATE_MODE — set "true" to enable Profile B template transactions.
       - BSV_NETWORK — "mainnet" or "testnet" (required).
       - LISTEN_ADDR — host:port the gateway binds to (default :8402).
    3. Seed the nonce pool (treasury fan-out).
       - Send BSV to the address derived from NONCE_WIF.
       - Run the fan-out command to split the funding UTXO into N x 1-sat outputs.
       - The gateway registers each resulting outpoint in the nonce pool.
    4. Seed the fee pool (treasury fan-out).
       - Send BSV to the address derived from FEE_WIF.
       - Run the fan-out command to split the funding UTXO into N x 1-sat outputs.
       - The gateway registers each resulting outpoint in the fee pool.
    5. Start the gateway.
       - Standalone binary: set env vars, run the binary.
       - Docker: build the image from the provided Dockerfile, or use docker-compose.yml which includes a Redis sidecar.
    6. Verify health.
       - GET /health returns JSON with pool stats: available, leased, and spent counts for each pool.
       - Confirm nonce pool available count matches the fan-out output count.
       - Confirm fee pool available count matches its fan-out output count.
    7. Configure monitoring.
       - Poll /health on a schedule and alert when any pool's available count drops below threshold.
       - Use the dashboard (if deployed) for real-time metrics.

  validation_rules:
    - Each pool (nonce, fee, payment) must use a distinct WIF key. Sharing keys across pools corrupts UTXO accounting.
    - Nonce pool UTXOs must be exactly 1 satoshi each.
    - Fee pool UTXOs must be exactly 1 satoshi each.
    - CHALLENGE_TTL must be a positive integer. Values below 30 seconds risk premature expiry; values above 600 seconds increase replay window.
    - TEMPLATE_MODE must be "true" or unset. Any other value is treated as false.
    - BSV_NETWORK must be "mainnet" or "testnet". Mismatched network causes key derivation failures.
    - Redis-backed pools are required for multi-instance deployments. In-memory pools are acceptable only for single-instance development.

  common_errors:
    - Using the same WIF for nonce and fee pools. This causes UTXOs to be double-counted across pools.
    - Forgetting to fan-out after funding. The pool address has a balance but no individual 1-sat UTXOs for the pool to lease.
    - Setting CHALLENGE_TTL too low (under 30s). Clients with slow networks or complex wallet flows will fail to respond before expiry.
    - Running multiple gateway instances with in-memory pools. Each instance tracks its own state, leading to double-leases and double-spends.
    - Deploying to mainnet with testnet keys (or vice versa). The gateway will fail to locate UTXOs on-chain.

  references:
    - x402 protocol specification (x402-spec.md), sections on challenge issuance and pool management.
    - BSV key derivation and WIF encoding (BIP-32, WIF format).
    - Docker Compose documentation for multi-container deployments.
