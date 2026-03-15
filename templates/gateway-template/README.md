# x402 Gateway Template

Scaffold for an x402 payment-gated HTTP API.

## Quick Start

1. Configure `.env` from `.env.example`
2. Generate keys for nonce and fee pools
3. Run: `go run .`

## Production Setup

1. Set up Redis for persistent UTXO pools
2. Fund nonce and fee pool addresses (treasury fan-out)
3. Configure payee locking script
4. Deploy with Docker: `docker-compose up -d`

See `skills/infrastructure/` for detailed operational guidance.

## Files

- `main.go` — HTTP server and route configuration
- `middleware.go` — x402 gatekeeper middleware (challenge issuance + proof verification)
- `Dockerfile` — Container build
- `docker-compose.yml` — Docker Compose with Redis
- `.env.example` — Configuration template
