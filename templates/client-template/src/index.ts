/**
 * x402 Client Template
 *
 * Drop-in x402 payment client. Configure and use client.fetch()
 * as a replacement for fetch() — it automatically handles 402
 * payment challenges.
 */
import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Configuration (from environment)
// ---------------------------------------------------------------------------

const TARGET_URL = process.env.TARGET_URL ?? "http://localhost:8402/v1/resource"
const DELEGATOR_URL = process.env.DELEGATOR_URL ?? "http://localhost:8402"
const DELEGATOR_PATH = process.env.DELEGATOR_PATH ?? "/delegate/x402"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Challenge {
  v: string
  scheme: string
  amount_sats: number
  payee_locking_script_hex: string
  expires_at: number
  nonce_utxo: { txid: string; vout: number; satoshis: number; locking_script_hex: string }
  template?: { rawtx_hex: string; price_sats: number } | null
  domain: string
  method: string
  path: string
  query: string
  req_headers_sha256: string
  req_body_sha256: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// x402 Client
// ---------------------------------------------------------------------------

async function x402Fetch(url: string, init?: RequestInit): Promise<Response> {
  // 1. Initial request
  const res = await fetch(url, init)

  if (res.status !== 402) {
    return res // Not a payment challenge — pass through
  }

  // 2. Parse challenge
  const challengeHeader = res.headers.get("x402-challenge")
  if (!challengeHeader) {
    throw new Error("402 response missing X402-Challenge header")
  }

  const { challenge, hash: challengeHash } = parseChallenge(challengeHeader)

  // 3. Build partial transaction
  const partialTxHex = buildPartialTx(challenge)
  const templateMode = !!(challenge.template?.rawtx_hex)

  // 4. Submit to delegator
  const delegRes = await fetch(`${DELEGATOR_URL}${DELEGATOR_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      partial_tx: partialTxHex,
      challenge_hash: challengeHash,
      payee_locking_script_hex: challenge.payee_locking_script_hex,
      amount_sats: challenge.amount_sats,
      nonce_outpoint: {
        txid: challenge.nonce_utxo.txid,
        vout: challenge.nonce_utxo.vout,
        satoshis: challenge.nonce_utxo.satoshis,
      },
      template_mode: templateMode,
    }),
  })

  if (!delegRes.ok) {
    throw new Error(`Delegator error ${delegRes.status}: ${await delegRes.text()}`)
  }

  const delegation = await delegRes.json() as { txid: string; completed_tx?: string; rawtx_hex?: string }
  const rawtxHex = delegation.completed_tx ?? delegation.rawtx_hex ?? ""

  // 5. Broadcast (TODO: implement for production)
  // await broadcastTx(rawtxHex)

  // 6. Retry with proof
  const parsedUrl = new URL(url)
  const rawtxBytes = Buffer.from(rawtxHex, "hex")

  const proof = {
    v: "1",
    scheme: "bsv-tx-v1",
    txid: delegation.txid,
    rawtx_b64: rawtxBytes.toString("base64"),
    challenge_sha256: challengeHash,
    request: {
      domain: parsedUrl.host,
      method: (init?.method ?? "GET").toUpperCase(),
      path: parsedUrl.pathname,
      query: parsedUrl.search.replace(/^\?/, ""),
      req_headers_sha256: challenge.req_headers_sha256,
      req_body_sha256: challenge.req_body_sha256,
    },
  }

  const proofHeader = Buffer.from(JSON.stringify(proof), "utf-8").toString("base64url")

  const retryHeaders = new Headers(init?.headers)
  retryHeaders.set("X402-Proof", proofHeader)

  return fetch(url, { ...init, headers: retryHeaders })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseChallenge(header: string): { challenge: Challenge; hash: string } {
  let payload = header
  const match = payload.match(/^v\d+\.[^.]+\.(.+)$/)
  if (match) payload = match[1]

  const raw = Buffer.from(payload, "base64url")
  const hash = createHash("sha256").update(raw).digest("hex")
  return { challenge: JSON.parse(raw.toString("utf-8")), hash }
}

function buildPartialTx(challenge: Challenge): string {
  if (challenge.template?.rawtx_hex) return challenge.template.rawtx_hex

  const nonce = challenge.nonce_utxo
  const parts: Buffer[] = []

  // Version
  const ver = Buffer.alloc(4); ver.writeUInt32LE(1); parts.push(ver)
  // Input count
  parts.push(Buffer.from([1]))
  // Prev txid (reversed)
  parts.push(Buffer.from(nonce.txid, "hex").reverse())
  // Prev vout
  const vout = Buffer.alloc(4); vout.writeUInt32LE(nonce.vout); parts.push(vout)
  // Empty scriptSig
  parts.push(Buffer.from([0]))
  // Sequence
  const seq = Buffer.alloc(4); seq.writeUInt32LE(0xffffffff); parts.push(seq)
  // Output count
  parts.push(Buffer.from([1]))
  // Value
  const val = Buffer.alloc(8); val.writeBigUInt64LE(BigInt(challenge.amount_sats)); parts.push(val)
  // Script
  const script = Buffer.from(challenge.payee_locking_script_hex, "hex")
  parts.push(Buffer.from([script.length]))
  parts.push(script)
  // Locktime
  parts.push(Buffer.alloc(4))

  return Buffer.concat(parts).toString("hex")
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Calling ${TARGET_URL} with x402 payment handling...`)
  const response = await x402Fetch(TARGET_URL)
  console.log(`Status: ${response.status}`)
  console.log(`Body: ${await response.text()}`)
}

main().catch(console.error)
