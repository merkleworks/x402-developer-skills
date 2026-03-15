/**
 * x402 Gateway Middleware Example (TypeScript/Express)
 *
 * Demonstrates the server-side gatekeeper pattern:
 * - Issues 402 challenges for unauthenticated requests
 * - Verifies payment proofs on retry
 * - Gates access to protected endpoints
 */
import express from "express"
import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

interface Challenge {
  v: string
  scheme: string
  amount_sats: number
  payee_locking_script_hex: string
  expires_at: number
  domain: string
  method: string
  path: string
  query: string
  req_headers_sha256: string
  req_body_sha256: string
  require_mempool_accept: boolean
  confirmations_required: number
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PAYEE_SCRIPT = process.env.PAYEE_SCRIPT ?? "76a914000000000000000000000000000000000000000088ac"
const AMOUNT_SATS = parseInt(process.env.AMOUNT_SATS ?? "100", 10)
const CHALLENGE_TTL_SECS = parseInt(process.env.CHALLENGE_TTL ?? "300", 10)
const PORT = parseInt(process.env.PORT ?? "8402", 10)

const HEADER_ALLOWLIST = [
  "accept",
  "content-length",
  "content-type",
  "x402-client",
  "x402-idempotency-key",
]

// ---------------------------------------------------------------------------
// Challenge cache (in-memory, use Redis in production)
// ---------------------------------------------------------------------------

const challengeCache = new Map<string, Challenge>()

// ---------------------------------------------------------------------------
// Hashing utilities
// ---------------------------------------------------------------------------

function sha256hex(data: string | Buffer): string {
  return createHash("sha256")
    .update(typeof data === "string" ? Buffer.from(data, "utf-8") : data)
    .digest("hex")
}

function hashHeaders(req: express.Request): string {
  const sorted = [...HEADER_ALLOWLIST].sort()
  const parts: string[] = []

  for (const key of sorted) {
    const value = (req.headers[key] as string) ?? ""
    const normalized = value.trim().replace(/\s+/g, " ")
    parts.push(`${key}:${normalized}`)
  }

  let canonical = parts.join("\n")
  if (parts.length > 0) canonical += "\n"

  return sha256hex(canonical)
}

function hashBody(body: string | undefined): string {
  return sha256hex(body ?? "")
}

// ---------------------------------------------------------------------------
// x402 Middleware
// ---------------------------------------------------------------------------

function x402Middleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const proofHeader = req.headers["x402-proof"] as string | undefined

  if (!proofHeader) {
    issueChallenge(req, res)
    return
  }

  verifyProof(req, res, next, proofHeader)
}

function issueChallenge(req: express.Request, res: express.Response): void {
  const challenge: Challenge = {
    v: "1",
    scheme: "bsv-tx-v1",
    amount_sats: AMOUNT_SATS,
    payee_locking_script_hex: PAYEE_SCRIPT,
    expires_at: Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECS,
    domain: req.headers.host ?? "localhost",
    method: req.method,
    path: req.path,
    query: req.url.includes("?") ? req.url.split("?")[1] : "",
    req_headers_sha256: hashHeaders(req),
    req_body_sha256: hashBody(req.body as string | undefined),
    require_mempool_accept: true,
    confirmations_required: 0,
    // nonce_utxo would be leased from pool in production
  }

  const challengeJSON = JSON.stringify(challenge)
  const challengeHash = sha256hex(Buffer.from(challengeJSON, "utf-8"))

  challengeCache.set(challengeHash, challenge)

  const encoded = Buffer.from(challengeJSON, "utf-8").toString("base64url")

  res.set("X402-Challenge", encoded)
  res.set("X402-Accept", "bsv-tx-v1")
  res.set("Cache-Control", "no-store")
  res.status(402).json({
    status: 402,
    code: "payment_required",
    message: "Payment required. See X402-Challenge header.",
  })
}

function verifyProof(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
  proofHeader: string,
): void {
  let proof: {
    v: string
    scheme: string
    txid: string
    rawtx_b64: string
    challenge_sha256: string
    request: {
      domain: string
      method: string
      path: string
      query: string
    }
  }

  try {
    const proofBytes = Buffer.from(proofHeader, "base64url")
    proof = JSON.parse(proofBytes.toString("utf-8"))
  } catch {
    res.status(400).json({ code: "invalid_proof", message: "cannot decode proof" })
    return
  }

  if (proof.v !== "1" || proof.scheme !== "bsv-tx-v1") {
    res.status(400).json({ code: "invalid_scheme", message: "unsupported version or scheme" })
    return
  }

  const challenge = challengeCache.get(proof.challenge_sha256)
  if (!challenge) {
    res.status(400).json({ code: "challenge_not_found", message: "challenge not found or expired" })
    return
  }

  if (challenge.expires_at <= Math.floor(Date.now() / 1000)) {
    res.status(402).json({ code: "expired_challenge", message: "challenge has expired" })
    return
  }

  // Verify request binding
  const currentQuery = req.url.includes("?") ? req.url.split("?")[1] : ""
  if (
    proof.request.domain !== (req.headers.host ?? "localhost") ||
    proof.request.method !== req.method ||
    proof.request.path !== req.path ||
    proof.request.query !== currentQuery
  ) {
    res.status(403).json({ code: "invalid_binding", message: "request binding mismatch" })
    return
  }

  // In production: verify nonce spend, payee output, mempool acceptance
  // (see verify-payment-proof.md skill for complete 16-step verification)

  // Compute receipt: SHA256(txid + ":" + challenge_sha256)
  const receiptHash = sha256hex(proof.txid + ":" + proof.challenge_sha256)

  // Delete challenge (single-use)
  challengeCache.delete(proof.challenge_sha256)

  res.set("X402-Receipt", receiptHash)
  res.set("X402-Status", "accepted")
  next()
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const app = express()

app.use(express.json())

// Protected endpoint
app.get("/v1/expensive", x402Middleware, (_req, res) => {
  res.json({
    data: "premium content",
    message: "Payment verified. Access granted.",
  })
})

// Health check (unprotected)
app.get("/health", (_req, res) => {
  res.json({ status: "ok" })
})

app.listen(PORT, () => {
  console.log(`x402 gateway listening on :${PORT}`)
})
