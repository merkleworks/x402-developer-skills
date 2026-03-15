# x402 Client Template

Scaffold for an x402 payment client.

## Quick Start

1. Configure `.env` from `.env.example`
2. Install: `npm install`
3. Run: `npm start`

## Usage

The `x402Fetch()` function is a drop-in replacement for `fetch()` that
automatically handles HTTP 402 payment challenges:

```typescript
const response = await x402Fetch("https://api.example.com/v1/resource")
```

For production use, see `@merkleworks/x402-client` for a full-featured client.

## Configuration

- `TARGET_URL` — The x402-protected API endpoint
- `DELEGATOR_URL` — Base URL of the delegator service
- `DELEGATOR_PATH` — Delegation endpoint path (default: `/delegate/x402`)
