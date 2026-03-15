"""
x402 Discovery Endpoint Example (Python)

Serves GET /.well-known/x402 returning a JSON document that enumerates
all x402-payable endpoints offered by this service.

Usage:
    python discovery.py
    curl http://localhost:8402/.well-known/x402

Requires: flask (pip install flask)
"""

import json
import os

from flask import Flask, Response

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Discovery document
# ---------------------------------------------------------------------------

DISCOVERY_DOCUMENT = {
    "protocol": "x402",
    "version": "1.0",
    "service": "Example x402 API",
    "endpoints": [
        {
            "path": "/v1/data",
            "method": "GET",
            "price_sats": 5,
            "currency": "BSV",
            "acceptance": "mempool",
            "description": "Retrieve premium dataset",
        },
        {
            "path": "/v1/compute",
            "method": "POST",
            "price_sats": 50,
            "currency": "BSV",
            "acceptance": "mempool",
            "description": "Run computation job",
        },
        {
            "path": "/v1/image",
            "method": "GET",
            "price_sats": 10,
            "currency": "BSV",
            "acceptance": "mempool",
            "description": "Generate image",
        },
    ],
}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.route("/.well-known/x402", methods=["GET"])
def discovery():
    body = json.dumps(DISCOVERY_DOCUMENT, indent=2)
    return Response(
        body,
        status=200,
        mimetype="application/json",
        headers={"Cache-Control": "public, max-age=300"},
    )


@app.route("/health", methods=["GET"])
def health():
    return Response(
        json.dumps({"status": "ok"}),
        status=200,
        mimetype="application/json",
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8402))
    print(f"x402 discovery endpoint listening on :{port}")
    print(f"  GET http://localhost:{port}/.well-known/x402")
    app.run(host="0.0.0.0", port=port)
