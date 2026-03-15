skill:
  name: call-x402-api
  category: client
  purpose: Use the X402Client SDK to call x402-protected APIs with automatic payment handling.
  when_to_use: When integrating with an x402-protected API using the official SDK rather than implementing the protocol manually.
  inputs: Delegator URL, broadcast URL (optional), target API endpoint, request parameters.
  outputs: HTTP response from the protected API, with 402 challenge/payment/retry handled transparently.

  procedure:
    1. Install the SDK package:
       - TypeScript: npm install @merkleworks/x402-client
       - Go: go get the x402 client package
    2. Configure the X402Client instance:
       - TypeScript:
         import { X402Client } from "@merkleworks/x402-client";
         const client = new X402Client({
           delegatorUrl: "https://delegator.example.com",
           broadcastUrl: "https://api.whatsonchain.com/v1/bsv/main/tx/raw",
           defaultHeaders: { "Authorization": "Bearer <token>" }
         });
       - Go: instantiate the client with delegator URL and options
    3. Use client.fetch() as a drop-in replacement for fetch():
       - TypeScript:
         const response = await client.fetch("https://api.example.com/protected/resource", {
           method: "GET",
           headers: { "Accept": "application/json" }
         });
       - The client intercepts 402 responses, extracts the challenge, delegates payment, broadcasts, and retries with proof automatically.
    4. Handle the final response as you would any HTTP response. The client resolves with the response from the successful retry (or the original response if no 402 was encountered).
    5. For non-GET requests with bodies, pass the body as usual. The client computes the request binding (body hash, headers hash) internally.

  validation_rules:
    - The X402Client is stateless. It does not hold a wallet, track balances, or persist payment history.
    - broadcastUrl defaults to WhatsOnChain mainnet if not specified.
    - defaultHeaders are included in every request made by the client, but are NOT included in the request binding computation unless the gateway's BindHeaders allowlist includes them.
    - The client.fetch() method has the same signature as the standard fetch() API. It returns a standard Response object.
    - The client handles retries for 202 (pending) responses internally with exponential backoff.
    - The client does not retry on 409 (double-spend) — it throws an error that the caller must handle.

  common_errors:
    - Passing an incorrect delegator URL. The delegator must be reachable and must support the POST /delegate/x402 endpoint.
    - Assuming the client manages wallet state or balances. The client delegates signing to the delegator and has no local key material.
    - Not handling 409 errors thrown by the client. Double-spend scenarios require the caller to decide whether to retry with a new request.
    - Setting broadcastUrl to a testnet endpoint when the gateway issues mainnet challenges, or vice versa.

  references:
    - @merkleworks/x402-client package documentation
    - x402 Protocol Specification v1
