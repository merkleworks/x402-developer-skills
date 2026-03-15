/**
 * x402 Discovery Endpoint Example (Node.js)
 *
 * Serves GET /.well-known/x402 returning a JSON document that enumerates
 * all x402-payable endpoints offered by this service.
 *
 * Usage:
 *   node discovery.js
 *   curl http://localhost:8402/.well-known/x402
 */

const http = require("http");

// ---------------------------------------------------------------------------
// Discovery document
// ---------------------------------------------------------------------------

const discoveryDocument = {
  protocol: "x402",
  version: "1.0",
  service: "Example x402 API",
  endpoints: [
    {
      path: "/v1/data",
      method: "GET",
      price_sats: 5,
      currency: "BSV",
      acceptance: "mempool",
      description: "Retrieve premium dataset",
    },
    {
      path: "/v1/compute",
      method: "POST",
      price_sats: 50,
      currency: "BSV",
      acceptance: "mempool",
      description: "Run computation job",
    },
    {
      path: "/v1/image",
      method: "GET",
      price_sats: 10,
      currency: "BSV",
      acceptance: "mempool",
      description: "Generate image",
    },
  ],
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 8402;

const server = http.createServer((req, res) => {
  if (req.url === "/.well-known/x402" && req.method === "GET") {
    const body = JSON.stringify(discoveryDocument, null, 2);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    });
    res.end(body);
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  console.log(`x402 discovery endpoint listening on :${PORT}`);
  console.log(`  GET http://localhost:${PORT}/.well-known/x402`);
});
