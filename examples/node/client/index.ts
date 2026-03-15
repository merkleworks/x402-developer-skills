/**
 * x402 Client Example (TypeScript)
 *
 * Demonstrates the x402 payment flow using raw fetch:
 * 1. Send request → receive 402 + challenge
 * 2. Parse challenge → build partial tx
 * 3. Submit to delegator → receive completed tx
 * 4. Broadcast tx → retry with proof
 *
 * For production use, prefer the X402Client from @merkleworks/x402-client
 * which handles this flow automatically.
 */
import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Protocol types (matching x402 wire format)
// ---------------------------------------------------------------------------

interface NonceRef {
  txid: string
  vout: number
  satoshis: number
  locking_script_hex: string
}

interface TemplateRef {
  rawtx_hex: string
  price_sats: number
}

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
  nonce_utxo: NonceRef
  template?: TemplateRef | null
  require_mempool_accept: boolean
  confirmations_required: number
}

interface Proof {
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
    req_headers_sha256: string
    req_body_sha256: string
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TARGET_URL = process.env.TARGET_URL ?? "http://localhost:8402/v1/expensive"
const DELEGATOR_URL = process.env.DELEGATOR_URL ?? "http://localhost:8402"
const DELEGATOR_PATH = "/delegate/x402"

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Step 1: Sending initial request...")
  const res = await fetch(TARGET_URL)

  if (res.status !== 402) {
    console.log(`Got status ${res.status} (not 402):`, await res.text())
    return
  }

  // Step 2: Parse challenge
  const challengeHeader = res.headers.get("x402-challenge")
  if (!challengeHeader) {
    throw new Error("402 response missing X402-Challenge header")
  }

  console.log("Step 2: Parsing challenge...")
  const { challenge, hash: challengeHash } = parseChallenge(challengeHeader)
  console.log(`  scheme=${challenge.scheme} amount=${challenge.amount_sats} sats`)
  console.log(`  nonce=${challenge.nonce_utxo.txid}:${challenge.nonce_utxo.vout}`)

  // Step 3: Check expiry
  const nowSecs = Math.floor(Date.now() / 1000)
  if (challenge.expires_at > 0 && challenge.expires_at < nowSecs) {
    throw new Error(`Challenge expired at ${challenge.expires_at}`)
  }

  // Step 4: Build partial transaction
  console.log("Step 3: Building partial transaction...")
  let partialTxHex: string
  let templateMode = false

  if (challenge.template?.rawtx_hex) {
    partialTxHex = challenge.template.rawtx_hex
    templateMode = true
    console.log("  using Profile B (gateway template)")
  } else {
    partialTxHex = buildUnsignedPartialTx(
      challenge.nonce_utxo,
      challenge.payee_locking_script_hex,
      challenge.amount_sats,
    )
    console.log("  using Profile A (open nonce)")
  }

  // Step 5: Submit to delegator
  console.log("Step 4: Submitting to delegator...")
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
    throw new Error(`Delegator returned ${delegRes.status}: ${await delegRes.text()}`)
  }

  const delegation = (await delegRes.json()) as {
    txid: string
    completed_tx?: string
    rawtx_hex?: string
  }
  const rawtxHex = delegation.completed_tx ?? delegation.rawtx_hex ?? ""
  console.log(`  delegator returned txid=${delegation.txid}`)

  // Step 6: Broadcast (in production, POST to WhatsOnChain or ARC)
  console.log("Step 5: Broadcasting transaction...")
  // await broadcastTx(rawtxHex)

  // Step 7: Build proof and retry
  console.log("Step 6: Retrying with proof...")
  const url = new URL(TARGET_URL)
  const rawtxBytes = Buffer.from(rawtxHex, "hex")

  const proof: Proof = {
    v: "1",
    scheme: "bsv-tx-v1",
    txid: delegation.txid,
    rawtx_b64: rawtxBytes.toString("base64"), // standard base64 with padding
    challenge_sha256: challengeHash,
    request: {
      domain: url.host,
      method: "GET",
      path: url.pathname,
      query: url.search.replace(/^\?/, ""),
      req_headers_sha256: challenge.req_headers_sha256,
      req_body_sha256: challenge.req_body_sha256,
    },
  }

  const proofHeader = Buffer.from(JSON.stringify(proof), "utf-8").toString("base64url")

  const retryRes = await fetch(TARGET_URL, {
    headers: { "X402-Proof": proofHeader },
  })

  console.log(`Step 7: Response status=${retryRes.status}`)
  console.log(`  X402-Receipt: ${retryRes.headers.get("x402-receipt")}`)
  console.log(`  X402-Status: ${retryRes.headers.get("x402-status")}`)
  console.log(`  Body: ${await retryRes.text()}`)
}

// ---------------------------------------------------------------------------
// Challenge parsing
// ---------------------------------------------------------------------------

function parseChallenge(headerValue: string): { challenge: Challenge; hash: string } {
  let payload = headerValue

  // Strip compact prefix: "v1.bsv-tx.<base64url>"
  const match = payload.match(/^v\d+\.[^.]+\.(.+)$/)
  if (match) {
    payload = match[1]
  }

  const rawBytes = Buffer.from(payload, "base64url")
  const hash = createHash("sha256").update(rawBytes).digest("hex")
  const challenge: Challenge = JSON.parse(rawBytes.toString("utf-8"))

  if (!challenge.nonce_utxo) {
    throw new Error("Challenge missing nonce_utxo")
  }

  return { challenge, hash }
}

// ---------------------------------------------------------------------------
// Transaction construction (Profile A)
// ---------------------------------------------------------------------------

function buildUnsignedPartialTx(
  nonce: NonceRef,
  lockingScriptHex: string,
  amountSats: number,
): string {
  const parts: Buffer[] = []

  // Version 1
  const version = Buffer.alloc(4)
  version.writeUInt32LE(1)
  parts.push(version)

  // Input count
  parts.push(encodeVarInt(1))

  // Previous output hash (reversed txid)
  parts.push(Buffer.from(nonce.txid, "hex").reverse())

  // Previous output index
  const vout = Buffer.alloc(4)
  vout.writeUInt32LE(nonce.vout)
  parts.push(vout)

  // ScriptSig (empty)
  parts.push(encodeVarInt(0))

  // Sequence
  const seq = Buffer.alloc(4)
  seq.writeUInt32LE(0xffffffff)
  parts.push(seq)

  // Output count
  parts.push(encodeVarInt(1))

  // Value
  const value = Buffer.alloc(8)
  value.writeBigUInt64LE(BigInt(amountSats))
  parts.push(value)

  // Locking script
  const script = Buffer.from(lockingScriptHex, "hex")
  parts.push(encodeVarInt(script.length))
  parts.push(script)

  // Locktime
  const locktime = Buffer.alloc(4)
  locktime.writeUInt32LE(0)
  parts.push(locktime)

  return Buffer.concat(parts).toString("hex")
}

function encodeVarInt(n: number): Buffer {
  if (n < 0xfd) return Buffer.from([n])
  if (n <= 0xffff) {
    const buf = Buffer.alloc(3)
    buf[0] = 0xfd
    buf.writeUInt16LE(n, 1)
    return buf
  }
  const buf = Buffer.alloc(5)
  buf[0] = 0xfe
  buf.writeUInt32LE(n, 1)
  return buf
}

// ---------------------------------------------------------------------------

main().catch(console.error)
