skill:
  name: run-delegator
  category: infrastructure
  purpose: Operate the delegator service that completes partial transactions by adding fee inputs without ever broadcasting.
  when_to_use: When deploying or debugging the delegator component that bridges client-signed partial transactions to broadcast-ready completed transactions.
  inputs: A partial transaction hex from the client, the challenge hash, payee locking script, required amount, and nonce UTXO details.
  outputs: A completed transaction (hex and txid) with fee inputs attached, ready for client-side broadcast.

  procedure:
    1. Receive request at POST /delegate/x402.
       - Request body fields:
         - partial_tx_hex — hex-encoded partial transaction from the client.
         - challenge_sha256 — SHA-256 hash of the original challenge JSON. Gateway implementations may accept the legacy alias challenge_hash for compatibility.
         - payee_locking_script_hex — expected locking script for the payee output.
         - amount_sats — minimum required satoshi value for the payee output.
         - nonce_utxo — object with txid, vout, and satoshis identifying the nonce UTXO.
         - template_mode — boolean indicating Profile B template transaction.
    2. Decode the partial transaction from hex to a transaction object.
    3. Verify exactly one nonce input is present in the transaction.
       - The nonce input must match nonce_utxo.txid and nonce_utxo.vout.
    4. Verify a payee output exists.
       - The output's locking script must equal payee_locking_script_hex (exact match).
       - The output's satoshi value must be greater than or equal to amount_sats.
    5. Check the replay cache for the nonce outpoint.
       - If the nonce outpoint is already recorded with a different txid, reject with 409 double_spend.
       - If recorded with the same txid, this is an idempotent retry; proceed.
    6. Enforce sighash policy on existing inputs.
       - Profile A: all input signature hash types must be 0xC1 (SIGHASH_ALL|ANYONECANPAY|FORKID) or 0x41 (SIGHASH_ALL|FORKID).
       - Profile B: input[0] must use 0xC3 (SIGHASH_SINGLE|ANYONECANPAY|FORKID), remaining inputs must use 0xC1 or 0x41.
       - Reject any input with a disallowed sighash type.
    7. Calculate the fee deficit.
       - Estimate completed transaction size: current size + (N fee inputs x 148 bytes) + change output (34 bytes).
       - Required fee = estimated size x fee rate (typically 1 sat/byte on BSV).
       - Fee deficit = required fee - (sum of existing input values - sum of existing output values).
    8. Lease fee UTXOs from the fee pool to cover the deficit.
       - Each fee UTXO is 1 satoshi.
       - Lease N UTXOs where N >= fee deficit.
    9. Append fee inputs to the transaction.
       - Sign each fee input with sighash type 0xC1 using FEE_WIF.
    10. Add a change output if the sum of all inputs exceeds the sum of all outputs plus the required fee.
    11. Return the completed transaction.
        - Response body: {txid, rawtx_hex, accepted: true}.
        - HTTP status 200.
    12. The delegator NEVER broadcasts the transaction. The client is responsible for broadcast.

  validation_rules:
    - The delegator must never broadcast a transaction. This is a protocol invariant. The client broadcasts.
    - Fee UTXOs must come from the fee pool, not the nonce pool. These pools are strictly separated.
    - Sighash enforcement is mandatory. A transaction with disallowed sighash types must be rejected before fee inputs are added.
    - The payee output check must use exact script comparison, not address comparison.
    - The nonce UTXO must be gateway-issued. The delegator does not accept client-supplied nonce UTXOs.
    - Fee rate is configurable but defaults to 1 sat/byte on BSV mainnet.

  common_errors:
    - Broadcasting the completed transaction from the delegator. This violates the protocol and removes the client's ability to abort.
    - Using nonce pool UTXOs as fee inputs. This depletes the nonce pool and corrupts pool accounting.
    - Skipping sighash validation. A transaction with SIGHASH_NONE could allow input theft after fee UTXOs are added.
    - Incorrect fee estimation that ignores the size of the fee inputs themselves, leading to underfunded transactions.
    - Returning a 200 response without the rawtx_hex field, leaving the client unable to broadcast.

  references:
    - x402 protocol specification, delegation flow and Profile A/B sighash rules.
    - BSV transaction format and sighash type definitions.
    - Error code table: invalid_partial_tx (400), insufficient_amount (402), invalid_payee (403), double_spend (409), no_utxos_available (503).
