skill:
  name: explain-x402-protocol
  category: protocol
  purpose: Explain the complete x402 stateless settlement-gated HTTP protocol from first principles.
  when_to_use: When a developer needs a comprehensive understanding of x402 before building clients, gateways, or delegators.
  inputs: None. This is a reference explanation.
  outputs: A complete technical description of the x402 protocol covering mechanism, headers, UTXO nonce model, profiles, funding modes, and architecture layers.
  procedure:
    1. Define the protocol identity.
       x402 is a stateless settlement-gated HTTP protocol. It uses the existing HTTP 402 Payment Required status code as a machine-readable challenge mechanism. The server does not track accounts, sessions, or balances. Every request is independently settled or rejected.

    2. Identify the payment scheme.
       Scheme identifier: `bsv-tx-v1`. This is carried in the `X402-Accept` header to declare which payment schemes the server supports. Currently only `bsv-tx-v1` is defined.

    3. Enumerate the protocol headers.
       - `X402-Challenge` — Server to client. Base64url-encoded JSON object describing the payment terms (amount, payee, nonce outpoint, expiry, request binding fields). Returned with HTTP 402.
       - `X402-Accept` — Server to client. Comma-separated list of accepted payment schemes. Returned with HTTP 402.
       - `X402-Proof` — Client to server. Base64url-encoded JSON object containing the broadcast txid, raw transaction hex, and nonce outpoint. Sent on the retry request.
       - `X402-Receipt` — Server to client. Base64url-encoded JSON receipt confirming settlement. Returned with HTTP 200.
       - `X402-Status` — Server to client. Machine-readable settlement status string. Returned with HTTP 200.

    4. Describe the UTXO nonce model.
       Every challenge includes a nonce, which is a 1-satoshi UTXO issued by the gateway. The client must consume this nonce as input[0] of the payment transaction. Because a UTXO can only be spent once (enforced by Bitcoin consensus), the nonce serves as a cryptographic single-use token. This eliminates the need for server-side replay tracking as a correctness requirement.

       Protocol invariant: the nonce is always gateway-issued. The client never supplies its own nonce. This prevents the client from controlling the replay-protection mechanism.

    5. Explain replay protection.
       Replay protection is a consequence of UTXO single-spend at the consensus layer. If an attacker attempts to resubmit a previously broadcast transaction, the BSV network rejects the double-spend. The server can optionally maintain an LRU cache of spent nonce outpoints as defence-in-depth, but this cache is not correctness-critical.

    6. State what x402 does not have.
       - No accounts. There is no user registration, login, or identity binding.
       - No sessions. Each HTTP request is independent.
       - No balance tracking. The server does not maintain prepaid credits or running totals.
       - No token refresh. There are no bearer tokens, API keys, or OAuth flows in the payment path.

    7. Describe the two profiles.
       Profile A — Open Nonce:
         The gateway issues the nonce UTXO without pre-signing. The client constructs the full transaction, signs its own inputs, submits to the delegator for fee injection, and broadcasts. This profile gives the client full control over transaction construction.

       Profile B — Gateway Template with 0xC3 Pre-Sign:
         The gateway pre-signs the nonce input using SIGHASH_SINGLE|ANYONECANPAY (0xC3). This binds the nonce input to a specific output (the payee output) but allows the client and delegator to add additional inputs and outputs. The client completes the transaction around the pre-signed template.

    8. Describe the two funding modes.
       Self-Funded Mode:
         The client provides its own fee inputs. The client is responsible for sourcing UTXOs to cover the mining fee. The delegator is not involved in fee provision.

       Sponsored Mode:
         A delegator provides fee inputs. The client submits a partial transaction to the delegator. The delegator validates the partial transaction, injects fee UTXOs (signed with SIGHASH_ALL|ANYONECANPAY, 0xC1), and returns the completed transaction. The delegator never broadcasts. The client broadcasts.

    9. Describe the 5-layer architecture.
       Layer 0 — BSV Network:
         UTXO single-spend enforcement. Mempool acceptance as the settlement signal. Global replay protection via consensus rules.

       Layer 1 — Fee Delegator:
         Validates partial transactions. Manages fee UTXO lifecycle. Enforces transaction policy (max fee, allowed script types). Injects fee inputs and signs them (0xC1). Returns the completed transaction. Never broadcasts. Never parses HTTP requests.

       Layer 2 — Gatekeeper:
         Generates 402 challenges. Binds challenges to the specific HTTP request (method, domain, path, query, headers hash, body hash). Sets pricing. Verifies proofs on retry. Gates the response (pass or reject). Never signs transactions. Never holds private keys.

       Layer 3 — Service/API:
         Business logic. The actual resource or computation behind the protected endpoint. Unaware of payment mechanics beyond receiving gated requests.

       Layer 4 — Commercial/Legal:
         Billing reconciliation. Service-level agreements. Rate plans. Exists outside the protocol boundary.

    10. Summarize the separation invariants.
        - The gatekeeper never signs transactions and never holds private keys.
        - The delegator never broadcasts transactions.
        - The delegator never parses or inspects HTTP request content.
        - The client constructs the transaction and is the sole broadcaster.
        - The BSV network is the sole arbiter of double-spend.

  validation_rules:
    - The nonce MUST be gateway-issued. Client-supplied nonces violate the protocol.
    - The challenge MUST bind to the specific HTTP request via deterministic hashing of method, domain, path, query, headers, and body.
    - The gatekeeper MUST NOT hold private keys or sign any transaction.
    - The delegator MUST NOT broadcast transactions.
    - The delegator MUST NOT parse HTTP request content.
    - The client MUST be the sole entity that broadcasts the completed transaction.
    - HTTP 402 responses MUST include Cache-Control: no-store.
    - The X402-Challenge payload MUST be base64url-encoded JSON.
    - The X402-Proof payload MUST be base64url-encoded JSON.

  common_errors:
    - Confusing x402 with a payment channel or escrow system. x402 is single-request settlement. There is no channel state.
    - Assuming the server tracks balances. Every request is independently settled.
    - Letting the gatekeeper sign transactions. The gatekeeper verifies proofs. Signing is the delegator's role (fee inputs only) and the client's role (payment inputs).
    - Letting the delegator broadcast. The client is always the broadcaster.
    - Treating the nonce as client-generated. The gateway mints and issues nonces.
    - Omitting Cache-Control: no-store on 402 responses, allowing intermediaries to cache challenges.
    - Confusing SIGHASH_ALL|ANYONECANPAY (0xC1, delegator fee signing) with SIGHASH_SINGLE|ANYONECANPAY (0xC3, Profile B nonce pre-sign).

  references:
    - x402 Protocol Specification (internal)
    - BSV UTXO model and SIGHASH flag definitions
    - RFC 9110 Section 15.5.3 (HTTP 402 Payment Required)
    - RFC 8785 (JSON Canonicalization Scheme)
    - RFC 4648 Section 5 (base64url encoding)
