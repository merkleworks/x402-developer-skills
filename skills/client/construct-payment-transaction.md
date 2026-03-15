skill:
  name: construct-payment-transaction
  category: client
  purpose: Low-level BSV transaction construction for x402 payment proofs, covering both Profile A and Profile B.
  when_to_use: When building the partial transaction that the delegator will complete, or when understanding the exact byte-level transaction structure required by x402.
  inputs: Challenge JSON containing nonce_utxo, payee_locking_script_hex, amount_sats, and optionally template.rawtx_hex.
  outputs: A hex-encoded partial transaction ready for submission to the delegator.

  procedure:
    1. Determine the challenge profile:
       - Profile A (open nonce): the challenge does NOT contain a template.rawtx_hex field. The client constructs the transaction from scratch.
       - Profile B (gateway template): the challenge contains template.rawtx_hex. The gateway has pre-signed input[0].
    2. Profile A construction:
       a. Set transaction version to 1 (4-byte little-endian).
       b. Create Input[0]:
          - prevTxID: nonce_utxo.txid decoded from hex and reversed to internal byte order (little-endian txid format used in raw transactions)
          - prevOutputIndex: nonce_utxo.vout (4-byte little-endian uint32)
          - scriptSig: empty (0x00 length prefix). The delegator will add the signature.
          - sequence: 0xFFFFFFFF (4-byte little-endian)
       c. Create Output[0]:
          - value: amount_sats as 8-byte little-endian uint64. Must be greater than or equal to the challenge amount_sats.
          - scriptPubKey: payee_locking_script_hex decoded from hex. Prefix with the script length as a varint.
       d. Set locktime to 0 (4-byte little-endian).
       e. The client signs the nonce input with sighash type 0xC1.
       f. Sighash 0xC1 = SIGHASH_ALL (0x01) | SIGHASH_ANYONECANPAY (0x80) | SIGHASH_FORKID (0x40).
          - SIGHASH_ALL: the signature commits to ALL outputs, preventing output modification.
          - SIGHASH_ANYONECANPAY: the signature commits to only the signing input, allowing the delegator to append additional inputs (fee inputs) without invalidating the signature.
          - SIGHASH_FORKID: required for all BSV transactions post-fork.
    3. Profile B construction:
       a. Decode template.rawtx_hex from hex to obtain the base raw transaction bytes.
       b. Parse the template transaction. Input[0] is already present and signed by the gateway with sighash 0xC3.
       c. Sighash 0xC3 = SIGHASH_SINGLE (0x03) | SIGHASH_ANYONECANPAY (0x80) | SIGHASH_FORKID (0x40).
          - SIGHASH_SINGLE: the gateway's signature commits to only the output at the same index as its input (output[0] = payee output). This binds input[0] to output[0].
          - SIGHASH_ANYONECANPAY: allows the sponsor to append additional inputs.
          - Combined effect: the gateway guarantees the payee gets paid (output[0] is locked), while the sponsor provides funding.
       d. The sponsor appends one or more funding inputs, each signed with sighash 0xC1.
       e. The sponsor may append additional outputs (e.g., change output) after output[0]. The gateway's 0xC3 signature does not cover these.
    4. Serialize the completed partial transaction to hex.
    5. Submit partial_tx (hex) to the delegator along with the challenge metadata (canonical fields: partial_tx, challenge_sha256, nonce_utxo; gateways may accept partial_tx_hex, challenge_hash as aliases).

  validation_rules:
    - The prevTxID in the raw transaction must be in reversed byte order (internal format), not the display format. If nonce_utxo.txid is "abcd...1234", reverse it byte-by-byte to "3412...cdab" for the raw transaction.
    - Output[0] value must be greater than or equal to amount_sats. Paying less causes proof verification to fail.
    - For Profile A, the scriptSig on input[0] must be empty when submitting to the delegator (the delegator signs it).
    - For Profile B, do not modify input[0] or output[0] from the template. The gateway's signature covers these.
    - Sighash 0xC1 and 0xC3 include the FORKID bit (0x40). Omitting FORKID produces an invalid BSV transaction.
    - All integer fields in the raw transaction are little-endian.

  common_errors:
    - Forgetting to reverse the txid bytes when constructing the raw transaction input. Display-order txid in a raw transaction produces an invalid outpoint reference.
    - Using sighash 0x01 (SIGHASH_ALL without ANYONECANPAY) instead of 0xC1. The delegator cannot append fee inputs if ANYONECANPAY is not set.
    - Modifying output[0] in a Profile B template, which invalidates the gateway's 0xC3 signature.
    - Setting output[0] value less than amount_sats from the challenge.
    - Using big-endian encoding for integer fields in the raw transaction.
    - Confusing Profile A and Profile B. Check for the presence of template.rawtx_hex in the challenge to determine the profile.

  references:
    - x402 Protocol Specification v1
    - BSV transaction serialization format
    - BIP 143 (transaction digest algorithm for signature verification, adapted for BSV)
