# x402 Developer Skills

AI developer skills enabling correct implementation of the x402 stateless settlement-gated HTTP protocol.

## Purpose

Structured protocol skills for AI coding systems (Claude Code, Cursor, agent environments) to:

- Understand the x402 protocol
- Integrate x402 payment gating into HTTP APIs
- Build x402 clients
- Operate infrastructure components (gateway, delegator, nonce mint)
- Enforce protocol security invariants

## Protocol Stability

The x402 wire protocol is **frozen for v0.1**. Challenge and proof structures, canonical hashing, delegator fields, and HTTP status semantics are stable. See [Protocol Stability](docs/PROTOCOL-STABILITY-LOCK.md) and [Wire Format Quick Reference](docs/protocol-summary.md#protocol-stability) for details.

## Authority Hierarchy

These skills are derived from:
1. **x402 Protocol Specification** (normative, Tier 1)
2. **Reference Implementation** (Tier 2)
3. **Architecture and economic models** (Tier 3-4)

When ambiguity exists: `protocol spec > reference implementation > these skills`

## Repository Structure

```
skills/
  protocol/                          Protocol architecture and mechanics
    explain-x402-protocol/SKILL.md
    architecture-overview/SKILL.md
    protocol-flow/SKILL.md
    deterministic-binding/SKILL.md
    replay-protection/SKILL.md
  client/                            Building x402 clients
    build-x402-client/SKILL.md
    call-x402-api/SKILL.md
    construct-payment-transaction/SKILL.md
  server/                            Server-side integration
    add-x402-to-http-api/SKILL.md
    implement-gateway/SKILL.md
    verify-payment-proof/SKILL.md
  infrastructure/                    Deploying and operating components
    run-x402-gateway/SKILL.md
    run-delegator/SKILL.md
    operate-nonce-mint/SKILL.md
  security/                          Protocol invariant enforcement
    validate-proof/SKILL.md
    detect-double-spend/SKILL.md
    enforce-request-binding/SKILL.md
  discovery/                         Service discovery
    implement-x402-discovery/SKILL.md
examples/
  go/                 Go examples (client, middleware, discovery)
  node/               TypeScript examples (client, middleware, discovery)
  python/             Python examples (client, gateway, discovery)
  rust/               Rust examples (client, middleware) — requires Rust 1.75+
templates/
  gateway-template/   Go gateway project scaffold
  client-template/    TypeScript client project scaffold
docs/
  protocol-summary.md   Wire format quick reference
  integration-guide.md  Step-by-step integration guide
```

## Install

Install the x402 developer skills into your AI coding tools with one command:

```
npx @merkleworks/x402-skills install
```

This copies skills into:
- `~/.claude/skills/x402` (Claude Code)
- `~/.cursor/skills/x402` (Cursor)

Other commands:
```
npx @merkleworks/x402-skills update      # Reinstall with latest version
npx @merkleworks/x402-skills uninstall   # Remove installed skills
npx @merkleworks/x402-skills doctor      # Diagnose and repair environment
npx @merkleworks/x402-skills init myapp  # Scaffold a new x402 project
```

## Usage

### Claude Code
After installing, skills are automatically available. Reference them with:
```
@x402/protocol/explain-x402-protocol
```

### Cursor
Add the skills directory to your project context for AI-assisted x402 implementation.

## Protocol Overview

x402 is a stateless settlement-gated HTTP protocol. Core properties:

- HTTP 402 Payment Required as the challenge mechanism
- Payment bound to request via deterministic hashing (RFC 8785 JCS)
- Replay protection enforced by UTXO single-use at consensus layer
- No accounts, no balance tracking, no subscription ledgers
- Deterministic request binding (method, path, query, headers, body)
- Payment -> proof -> execution flow

## Normative References

**Normative specification**
https://github.com/merkleworks/x402-spec

**Reference implementation**
https://github.com/merkleworks/x402-reference

These documents define the authoritative protocol behavior.
When resolving ambiguity: `specification > reference implementation > these skills`.

## Service Discovery

Services supporting x402 should expose a discovery endpoint at:

```
GET /.well-known/x402
```

This returns a JSON document listing all payable endpoints, their prices, and
acceptance policies. AI agents can fetch this endpoint to automatically discover
and pay for x402-gated APIs without prior configuration.

See `skills/discovery/implement-x402-discovery/SKILL.md` for the full specification.

## Scheme Identifier

`bsv-tx-v1`

## Wire Headers

| Header | Direction | Purpose |
|--------|-----------|---------|
| `X402-Challenge` | Server -> Client | Base64url-encoded challenge JSON |
| `X402-Proof` | Client -> Server | Base64url-encoded proof JSON |
| `X402-Accept` | Server -> Client | Supported payment schemes |
| `X402-Receipt` | Server -> Client | SHA256(txid + ":" + challenge_sha256) |
| `X402-Status` | Server -> Client | Mempool status: accepted, pending, rejected, error |
