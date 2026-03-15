skill:
  name: implement-x402-discovery
  category: discovery

  purpose: |
    Expose a machine-readable discovery endpoint at `/.well-known/x402` so that
    AI agents and HTTP clients can programmatically enumerate all x402-payable
    resources offered by a service.

  when_to_use: |
    - When deploying an x402-gated API that should be discoverable by automated clients.
    - When building an AI agent that needs to find payable endpoints before calling them.
    - When integrating a service catalogue or gateway that aggregates x402 providers.

  inputs:
    - Service name (human-readable identifier).
    - List of x402-gated endpoints with method, path, price, and acceptance policy.

  outputs:
    - An HTTP endpoint at `GET /.well-known/x402` returning the discovery document.

  specification: |
    The discovery document is a JSON object with the following schema:

    ```json
    {
      "protocol": "x402",
      "version": "1.0",
      "service": "<service_name>",
      "endpoints": [
        {
          "path": "/resource",
          "method": "GET",
          "price_sats": 5,
          "currency": "BSV",
          "acceptance": "mempool",
          "description": "Optional human-readable description"
        }
      ]
    }
    ```

    Field definitions:

    | Field | Type | Required | Description |
    |-------|------|----------|-------------|
    | `protocol` | string | yes | Must be `"x402"`. |
    | `version` | string | yes | Discovery document version. Currently `"1.0"`. |
    | `service` | string | yes | Human-readable service name. |
    | `endpoints` | array | yes | List of payable endpoint descriptors. |
    | `endpoints[].path` | string | yes | URL path of the gated resource. |
    | `endpoints[].method` | string | yes | HTTP method (`GET`, `POST`, etc.). |
    | `endpoints[].price_sats` | integer | yes | Minimum payment in satoshis. |
    | `endpoints[].currency` | string | yes | Settlement currency. Must be `"BSV"`. |
    | `endpoints[].acceptance` | string | yes | Confirmation policy: `"mempool"`, `"1-conf"`, or `"6-conf"`. |
    | `endpoints[].description` | string | no | Optional description of the resource. |

  procedure:
    1. Define the list of x402-gated endpoints in server configuration.
    2. Register a handler for `GET /.well-known/x402`.
    3. On request, construct the discovery document JSON from the endpoint list.
    4. Return the document with `Content-Type: application/json` and status `200`.
    5. Do not require payment or authentication for the discovery endpoint itself.
    6. Keep the endpoint list synchronised with actual gateway pricing configuration.

  validation_rules:
    - The endpoint MUST be served at exactly `/.well-known/x402`.
    - The response MUST have `Content-Type: application/json`.
    - The response status MUST be `200 OK`.
    - `protocol` MUST equal `"x402"`.
    - `version` MUST equal `"1.0"`.
    - Every entry in `endpoints` MUST include `path`, `method`, `price_sats`, `currency`, and `acceptance`.
    - `price_sats` MUST be a non-negative integer.
    - `currency` MUST be `"BSV"`.
    - `acceptance` MUST be one of `"mempool"`, `"1-conf"`, `"6-conf"`.
    - The discovery endpoint itself MUST NOT be payment-gated.

  common_errors:
    - Gating the discovery endpoint behind x402 (clients cannot discover without paying).
    - Returning price_sats as a string instead of an integer.
    - Omitting the method field (clients cannot construct the correct request).
    - Serving at /x402 instead of /.well-known/x402.
    - Letting the endpoint list drift from actual gateway configuration.
    - Missing Content-Type header on the response.

  references:
    - x402 protocol specification
    - RFC 8615 (Well-Known URIs)
    - RFC 8259 (JSON)
