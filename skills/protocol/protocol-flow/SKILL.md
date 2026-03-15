skill:
  name: protocol-flow
  category: protocol
  purpose: Describe the complete 8-step x402 settlement flow from initial request to gated response.
  when_to_use: When a developer needs to implement a client, gatekeeper, or delegator and must understand the exact sequence of operations.
  inputs: None. This is a reference description of the protocol flow.
  outputs: A step-by-step walkthrough of the settlement flow with an ASCII sequence diagram.
  normative: Wire contract is defined by the protocol spec (01-protocol/Protocol-Spec.md). In case of conflict, the spec prevails.
  procedure:
    1. Step 1 — Client sends initial HTTP request (no proof).
       The client sends a standard HTTP request to the protected endpoint. The request does not contain an X402-Proof header. The client may not yet know the endpoint requires payment.

       Request example:
         GET /api/v1/resource HTTP/1.1
         Host: api.example.com
         Accept: application/json

    2. Step 2 — Server returns HTTP 402 with challenge.
       The gatekeeper intercepts the request, determines that payment is required, and constructs a challenge. The response includes:
         - Status: 402 Payment Required
         - X402-Challenge: base64url-encoded JSON challenge object
         - X402-Accept: bsv-tx-v1
         - Cache-Control: no-store

       Challenge JSON structure (before base64url encoding):
         {
           "v": "1",
           "scheme": "bsv-tx-v1",
           "amount_sats": 1000,
           "payee_locking_script_hex": "76a914...88ac",
           "expires_at": 1742040300,
           "domain": "api.example.com",
           "method": "GET",
           "path": "/api/v1/resource",
           "query": "",
           "req_headers_sha256": "a1b2c3...hex",
           "req_body_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
           "nonce_utxo": {
             "txid": "abcdef0123456789...",
             "vout": 0,
             "satoshis": 1,
             "locking_script_hex": "76a914...88ac"
           },
           "require_mempool_accept": true,
           "confirmations_required": 0
         }

       The req_body_sha256 for an empty body is the SHA-256 of the empty string.
       The nonce_utxo is a 1-sat UTXO minted and owned by the gatekeeper.

    3. Step 3 — Client parses and validates the challenge.
       The client base64url-decodes the X402-Challenge header, parses the JSON, and validates:
         - scheme is "bsv-tx-v1" (or a scheme the client supports)
         - expires_at (unix timestamp) is in the future
         - amount_sats is acceptable to the client
         - nonce_utxo contains a valid object with txid (64-char hex) and vout (integer)

    4. Step 4 — Client builds partial transaction.
       The client constructs a partial BSV transaction:
         - input[0]: nonce UTXO (from nonce_utxo in the challenge). The client creates an unsigned input referencing this outpoint.
         - output[0]: payee output. Locking script = payee_locking_script_hex from the challenge. Value >= amount_sats from the challenge.
         - Additional inputs: the client's payment UTXOs (signed by the client).
         - Additional outputs: change output(s) as needed.

       The client signs its own inputs. The nonce input (input[0]) is left unsigned if using Profile A (open nonce), or carries the gateway's pre-signature if using Profile B (0xC3).

    5. Step 5 — Client submits partial transaction to the delegator.
       In Sponsored funding mode, the client sends the partial transaction to the delegator:

       POST /delegate/x402 HTTP/1.1
       Content-Type: application/json

       {
         "partial_tx": "0100000001...incomplete",
         "challenge_sha256": "sha256-of-jcs-canonicalized-challenge-json-hex",
         "payee_locking_script_hex": "76a914...88ac",
         "amount_sats": 1000,
         "nonce_utxo": { "txid": "abcdef0123456789...", "vout": 0 }
       }

       Use canonical field names. Gateway implementations may accept legacy aliases (e.g. partial_tx_hex for partial_tx).

       The challenge_sha256 is computed by:
         a. Serialize the challenge JSON using RFC 8785 JCS (sort keys lexicographically, no whitespace, deterministic number encoding).
         b. SHA-256 the UTF-8 bytes of the canonical JSON.
         c. Encode as lowercase hex.

       In Self-Funded mode, the client skips this step. The client provides its own fee inputs and proceeds directly to broadcast.

    6. Step 6 — Delegator validates, adds fee inputs, returns completed transaction.
       The delegator performs the following:
         a. Deserializes the partial transaction.
         b. Validates input[0] references the declared nonce_utxo.
         c. Validates output[0] pays the declared payee_locking_script_hex with value >= amount_sats.
         d. Validates the challenge_sha256 against the declared parameters.
         e. Checks policy constraints (max fee, allowed script types, tx size limits).
         f. Atomically reserves fee UTXOs from its pool.
         g. Appends fee input(s) to the transaction.
         h. Signs fee inputs with SIGHASH_ALL|ANYONECANPAY (0xC1).
         i. Computes the final txid.
         j. Returns the response:

       {
         "txid": "final-txid-hex",
         "rawtx_hex": "0100000001...complete",
         "accepted": true
       }

       The delegator NEVER broadcasts. The delegator returns the raw transaction to the client.

    7. Step 7 — Client broadcasts completed transaction to BSV network.
       The client takes the rawtx_hex from the delegator response (or from its own construction in Self-Funded mode) and broadcasts it to the BSV network via a node or broadcast API.

       Possible outcomes:
         - 200: Transaction accepted into mempool. Proceed.
         - 202: Transaction seen but pending. Proceed with caution (may need to poll).
         - 409: Double-spend. The nonce or a fee UTXO was already spent. Abort and request a new challenge.
         - 503: Node error. Retry broadcast.

    8. Step 8 — Client retries original request with proof.
       The client resends the original HTTP request with the X402-Proof header:

       GET /api/v1/resource HTTP/1.1
       Host: api.example.com
       Accept: application/json
       X402-Proof: <base64url-encoded proof JSON>

       The X402-Proof header MAY use the compact prefix form: v1.bsv-tx.<base64url(proof JSON)>. The gateway MUST accept both plain base64url and the compact form. The client MAY also send X402-Tx: <hex rawtx> as an optional alternative to embedding rawtx_b64 in the proof.

       Proof JSON structure (before base64url encoding):
         {
           "v": "1",
           "scheme": "bsv-tx-v1",
           "txid": "final-txid-hex",
           "rawtx_b64": "AQAAAAE...",
           "challenge_sha256": "def456...",
           "request": {
             "domain": "api.example.com",
             "method": "GET",
             "path": "/api/v1/resource",
             "query": "",
             "req_headers_sha256": "a1b2c3...hex",
             "req_body_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
           }
         }

    9. Step 9 — Server verifies proof and returns gated response.
       The gatekeeper executes the 16-step verification procedure:
         a. Decode the X402-Proof from base64url.
         b. Validate scheme is "bsv-tx-v1".
         c. Deserialize rawtx_hex into a transaction.
         d. Verify the computed txid matches the declared txid.
         e. Verify input[0] references the nonce_utxo from the original challenge.
         f. Verify output[0] pays the payee_locking_script_hex with value >= amount_sats.
         g. Re-derive the challenge from the current request's binding fields (domain, method, path, query, headers hash, body hash).
         h. Compute the challenge_sha256 from the re-derived challenge using JCS + SHA-256.
         i. Verify the challenge_sha256 matches the one embedded or expected.
         j. Verify the nonce_utxo has not been previously accepted (optional LRU cache check).
         k. Verify the transaction is visible in the mempool or a block (broadcast confirmation).
         l. Verify the nonce UTXO is spent (confirms the transaction was actually mined or mempool-accepted).
         m. Verify all signatures in the transaction are valid.
         n. Verify the transaction is not malformed (no extra unexpected outputs, script sizes within bounds).
         o. Verify expires_at has not passed.
         p. Record the nonce_utxo as accepted.

       If verification passes:
         - Forward the request to the service.
         - Return the service response with:
           - X402-Receipt: base64url-encoded receipt JSON
           - X402-Status: "settled"
           - Status: 200 (or whatever the service returns)

       If verification fails:
         - Return 402 (need new payment), 400 (malformed proof), or 409 (double-spend detected).

    10. ASCII sequence diagram.

        Client              Gatekeeper           Delegator         BSV Network
          |                      |                    |                  |
          |--- GET /resource --->|                    |                  |
          |                      |                    |                  |
          |<-- 402 + Challenge --|                    |                  |
          |    X402-Challenge    |                    |                  |
          |    X402-Accept       |                    |                  |
          |    Cache-Control     |                    |                  |
          |                      |                    |                  |
          |-- parse challenge -->|                    |                  |
          |-- build partial tx   |                    |                  |
          |                      |                    |                  |
          |--- POST /delegate/x402 ----------------->|                  |
          |    {partial_tx,      |                    |                  |
          |     challenge_sha256,  |                    |                  |
          |     payee, amount,   |                    |                  |
          |     nonce_utxo}      |                    |                  |
          |                      |                    |                  |
          |<-- {txid, rawtx, accepted} -------------|                  |
          |                      |                    |                  |
          |--- broadcast rawtx --------------------------------------------->|
          |                      |                    |                  |
          |<-- 200 (mempool accepted) ----------------------------------|
          |                      |                    |                  |
          |--- GET /resource --->|                    |                  |
          |    X402-Proof        |                    |                  |
          |                      |                    |                  |
          |                      |-- verify proof     |                  |
          |                      |-- check mempool ----------------------->|
          |                      |<- tx visible ----------------------------|
          |                      |                    |                  |
          |<-- 200 + Response ---|                    |                  |
          |    X402-Receipt      |                    |                  |
          |    X402-Status       |                    |                  |
          |                      |                    |                  |

  validation_rules:
    - The client MUST NOT send X402-Proof on the initial request unless retrying a previously failed proof.
    - The server MUST return Cache-Control: no-store with every 402 response.
    - The client MUST validate challenge expiry before building a transaction.
    - The partial transaction MUST have the nonce UTXO as input[0] and the payee output as output[0].
    - The delegator MUST atomically reserve fee UTXOs before signing.
    - The delegator MUST return the completed transaction without broadcasting it.
    - The client MUST broadcast before retrying with the proof.
    - The gatekeeper MUST re-derive the challenge from the current request binding fields during verification. It MUST NOT trust challenge data embedded in the proof.
    - The gatekeeper MUST verify the txid matches the hash of the raw transaction.
    - The gatekeeper MUST verify the transaction is visible in the mempool or a block.

  common_errors:
    - Broadcasting before the delegator returns. The client must wait for the delegator to return the completed transaction (with fee inputs) before broadcasting.
    - Sending the proof before broadcasting. The server will check mempool visibility. If the transaction has not been broadcast, verification fails.
    - Reusing a challenge after expiry. The nonce lease has a TTL. Expired challenges must be discarded and a new 402 cycle initiated.
    - Trusting the proof's embedded challenge data. The gatekeeper must re-derive the challenge from the actual HTTP request, not from data the client supplies in the proof.
    - Ignoring broadcast response codes. A 409 (double-spend) means the nonce or fee UTXO was already spent. The client must request a new challenge.
    - Omitting the challenge_sha256 from the proof. The gatekeeper needs this to match the proof to the original challenge.
    - Using the wrong SIGHASH flag. Fee inputs use 0xC1 (ALL|ANYONECANPAY). Profile B nonce pre-sign uses 0xC3 (SINGLE|ANYONECANPAY). Mixing these corrupts the transaction.

  references:
    - x402 Protocol Specification (internal)
    - BSV transaction format and serialization
    - RFC 9110 Section 15.5.3 (HTTP 402 Payment Required)
    - RFC 8785 (JSON Canonicalization Scheme)
    - RFC 4648 Section 5 (base64url encoding)
