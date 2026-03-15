skill:
  name: operate-nonce-mint
  category: infrastructure
  purpose: Manage the full lifecycle of nonce UTXOs from minting through lease, spend, and replenishment.
  when_to_use: When minting new nonce UTXOs, diagnosing pool depletion, configuring auto-replenishment, or cleaning up stale pool state.
  inputs: NONCE_WIF (private key for the nonce address), funding transaction, target UTXO count, pool storage backend (Redis or in-memory).
  outputs: A healthy nonce pool with sufficient available 1-sat UTXOs, correct lease/reclaim cycling, and monitoring alerts configured.

  procedure:
    1. Derive the nonce address from NONCE_WIF.
       - Use standard P2PKH address derivation from the WIF-encoded private key.
    2. Fund the nonce address.
       - Send BSV to the derived address. The amount determines how many 1-sat UTXOs can be minted (minus tx fee).
    3. Create the fan-out transaction.
       - Input: the funding UTXO.
       - Outputs: N x 1-sat outputs, each using the P2PKH locking script derived from the nonce key.
       - Change output: remaining value minus fee, sent back to the nonce address or a treasury address.
       - Fee estimation: minimum tx size = 10 (overhead) + 148 (one input) + (N x 34) (outputs) bytes.
       - Sign the input with NONCE_WIF.
    4. Broadcast the fan-out transaction.
       - Submit to the BSV network via node RPC or broadcast API.
       - Wait for txid confirmation (mempool acceptance is sufficient).
    5. Register minted UTXOs in the nonce pool.
       - For each output index i (0 to N-1), add outpoint {txid, vout: i, satoshis: 1} to the available set.
    6. Lease cycle (runtime, managed by the gateway).
       - Lease: atomically move one UTXO from available to leased. Assign a TTL (default 300 seconds, matching CHALLENGE_TTL).
       - The leased UTXO is included in a challenge response to the client.
    7. Reclaim cycle (background loop, every 30 seconds).
       - Scan all leased UTXOs.
       - If lease TTL has expired and the UTXO has not been marked spent, move it back to available.
       - This recovers nonces from abandoned or timed-out challenges.
    8. Mark spent (on proof acceptance).
       - When a valid proof references a nonce outpoint, mark that outpoint as spent.
       - Spent UTXOs are permanently removed from the pool. They must not be reclaimed.
    9. Zombie cleanup (periodic, every 10 minutes).
       - Sample a batch of "available" UTXOs.
       - Query the BSV node to confirm each is still unspent on-chain.
       - Quarantine any that are already spent (zombie UTXOs).
       - Zombies indicate an external spend or a missed mark-spent event.
    10. Monitor pool health.
        - Track: available count, leased count, spent count, mint rate, consumption rate.
        - Alert when available count drops below 10,000.
        - Trigger auto-replenish when available count drops below 5,000.
    11. Auto-replenish (optional).
        - When triggered, repeat steps 2-5 automatically using a pre-funded treasury address.
        - Log the mint transaction txid for audit.

  validation_rules:
    - Every nonce UTXO must be exactly 1 satoshi.
    - Nonce UTXOs must be owned by the gateway (derived from NONCE_WIF). Client-supplied nonces are invalid. This is a protocol invariant.
    - The lease operation must be atomic. Two concurrent lease requests must never receive the same UTXO.
    - A spent UTXO must never be reclaimed. The mark-spent operation takes permanent precedence over the reclaim timer.
    - Fan-out outputs must use P2PKH locking scripts. Other script types are not supported for nonce UTXOs.
    - Redis backend: use ZSET with score = lease expiry timestamp for efficient reclaim scans.
    - In-memory backend: acceptable only for single-instance development. Not safe for production multi-instance deployments.

  common_errors:
    - Funding the nonce address but skipping the fan-out step. The pool has zero available UTXOs despite the address having a balance.
    - Setting the reclaim interval longer than CHALLENGE_TTL. This delays recovery of expired nonces and can starve the pool under load.
    - Not marking spent UTXOs before the reclaim timer fires. The reclaimed UTXO gets re-leased, and a second client receives a nonce that is already spent on-chain.
    - Running zombie cleanup too aggressively (every few seconds). This creates excessive node RPC load.
    - Using the nonce pool key (NONCE_WIF) for fee inputs. Nonce and fee pools must use separate keys.
    - Creating fan-out outputs with more than 1 satoshi. The protocol expects 1-sat nonces; larger values waste funds.

  references:
    - x402 protocol specification, nonce UTXO requirements and challenge flow.
    - BSV P2PKH locking script format.
    - Redis ZSET documentation for sorted-set-based pool storage.
