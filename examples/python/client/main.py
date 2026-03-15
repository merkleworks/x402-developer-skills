"""
x402 Client Example (Python)

Demonstrates the x402 payment flow using raw HTTP and wire protocol:
1. Send request → receive 402 + challenge
2. Parse challenge → build partial tx
3. Submit to delegator → receive completed tx
4. Broadcast tx → retry with proof

This example uses no BSV SDK — it constructs raw transaction bytes
to illustrate the wire protocol directly.
"""

import base64
import hashlib
import json
import os
import struct
import sys

import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

TARGET_URL = os.getenv("TARGET_URL", "http://localhost:8402/v1/expensive")
DELEGATOR_URL = os.getenv("DELEGATOR_URL", "http://localhost:8402")
DELEGATOR_PATH = "/delegate/x402"


# ---------------------------------------------------------------------------
# Challenge parsing
# ---------------------------------------------------------------------------

def parse_challenge(header_value: str) -> tuple[dict, str]:
    """Parse the X402-Challenge header value.

    Returns (challenge_dict, challenge_hash_hex).
    """
    payload = header_value

    # Strip compact prefix: "v1.bsv-tx.<base64url>"
    parts = payload.split(".", 2)
    if len(parts) == 3:
        payload = parts[2]

    # base64url decode (no padding)
    raw_bytes = base64.urlsafe_b64decode(payload + "==")
    challenge_hash = hashlib.sha256(raw_bytes).hexdigest()
    challenge = json.loads(raw_bytes.decode("utf-8"))

    if "nonce_utxo" not in challenge:
        raise ValueError("Challenge missing nonce_utxo")

    return challenge, challenge_hash


# ---------------------------------------------------------------------------
# Transaction construction (Profile A)
# ---------------------------------------------------------------------------

def encode_varint(n: int) -> bytes:
    """Encode an integer as a Bitcoin varint."""
    if n < 0xFD:
        return struct.pack("<B", n)
    if n <= 0xFFFF:
        return b"\xfd" + struct.pack("<H", n)
    if n <= 0xFFFFFFFF:
        return b"\xfe" + struct.pack("<I", n)
    return b"\xff" + struct.pack("<Q", n)


def build_unsigned_partial_tx(
    nonce_txid: str,
    nonce_vout: int,
    locking_script_hex: str,
    amount_sats: int,
) -> str:
    """Build an unsigned BSV transaction with one input and one output.

    Input: nonce UTXO (unsigned)
    Output: payee payment (locking script + amount)

    Returns hex-encoded raw transaction.
    """
    parts = []

    # Version (4 LE)
    parts.append(struct.pack("<I", 1))

    # Input count
    parts.append(encode_varint(1))

    # Previous output hash (reversed txid bytes)
    txid_bytes = bytes.fromhex(nonce_txid)
    parts.append(txid_bytes[::-1])

    # Previous output index (4 LE)
    parts.append(struct.pack("<I", nonce_vout))

    # ScriptSig length (0 — unsigned)
    parts.append(encode_varint(0))

    # Sequence
    parts.append(struct.pack("<I", 0xFFFFFFFF))

    # Output count
    parts.append(encode_varint(1))

    # Value (8 LE)
    parts.append(struct.pack("<Q", amount_sats))

    # Locking script
    script = bytes.fromhex(locking_script_hex)
    parts.append(encode_varint(len(script)))
    parts.append(script)

    # Locktime (4 LE)
    parts.append(struct.pack("<I", 0))

    return b"".join(parts).hex()


# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------

def main() -> None:
    # Step 1: Send initial request
    print("Step 1: Sending initial request...")
    resp = requests.get(TARGET_URL)

    if resp.status_code != 402:
        print(f"Got status {resp.status_code} (not 402): {resp.text}")
        return

    # Step 2: Parse challenge
    challenge_header = resp.headers.get("X402-Challenge", "")
    if not challenge_header:
        print("ERROR: 402 response missing X402-Challenge header")
        sys.exit(1)

    print("Step 2: Parsing challenge...")
    challenge, challenge_hash = parse_challenge(challenge_header)
    print(f"  scheme={challenge['scheme']} amount={challenge['amount_sats']} sats")
    nonce = challenge["nonce_utxo"]
    print(f"  nonce={nonce['txid']}:{nonce['vout']}")

    # Step 3: Check expiry
    import time

    if challenge.get("expires_at", 0) > 0:
        if challenge["expires_at"] < int(time.time()):
            print("ERROR: Challenge expired")
            sys.exit(1)

    # Step 4: Build partial transaction
    print("Step 3: Building partial transaction...")
    template = challenge.get("template")
    template_mode = False

    if template and template.get("rawtx_hex"):
        partial_tx_hex = template["rawtx_hex"]
        template_mode = True
        print("  using Profile B (gateway template)")
    else:
        partial_tx_hex = build_unsigned_partial_tx(
            nonce_txid=nonce["txid"],
            nonce_vout=nonce["vout"],
            locking_script_hex=challenge["payee_locking_script_hex"],
            amount_sats=challenge["amount_sats"],
        )
        print("  using Profile A (open nonce)")

    # Step 5: Submit to delegator
    print("Step 4: Submitting to delegator...")
    deleg_resp = requests.post(
        f"{DELEGATOR_URL}{DELEGATOR_PATH}",
        json={
            "partial_tx": partial_tx_hex,
            "challenge_hash": challenge_hash,
            "payee_locking_script_hex": challenge["payee_locking_script_hex"],
            "amount_sats": challenge["amount_sats"],
            "nonce_outpoint": {
                "txid": nonce["txid"],
                "vout": nonce["vout"],
                "satoshis": nonce.get("satoshis", 1),
            },
            "template_mode": template_mode,
        },
    )

    if deleg_resp.status_code != 200:
        print(f"ERROR: Delegator returned {deleg_resp.status_code}: {deleg_resp.text}")
        sys.exit(1)

    delegation = deleg_resp.json()
    txid = delegation["txid"]
    rawtx_hex = delegation.get("completed_tx") or delegation.get("rawtx_hex", "")
    print(f"  delegator returned txid={txid}")

    # Step 6: Broadcast (in production, POST to WhatsOnChain or ARC)
    print("Step 5: Broadcasting transaction...")
    # broadcast_tx(rawtx_hex)

    # Step 7: Build proof and retry
    print("Step 6: Retrying with proof...")
    from urllib.parse import urlparse

    parsed_url = urlparse(TARGET_URL)
    rawtx_bytes = bytes.fromhex(rawtx_hex)

    proof = {
        "v": "1",
        "scheme": "bsv-tx-v1",
        "txid": txid,
        "rawtx_b64": base64.b64encode(rawtx_bytes).decode("ascii"),  # standard base64
        "challenge_sha256": challenge_hash,
        "request": {
            "domain": parsed_url.netloc,
            "method": "GET",
            "path": parsed_url.path,
            "query": parsed_url.query or "",
            "req_headers_sha256": challenge["req_headers_sha256"],
            "req_body_sha256": challenge["req_body_sha256"],
        },
    }

    proof_json = json.dumps(proof, separators=(",", ":"))
    # Outer encoding: base64url without padding
    proof_header = base64.urlsafe_b64encode(proof_json.encode("utf-8")).rstrip(b"=").decode("ascii")

    retry_resp = requests.get(TARGET_URL, headers={"X402-Proof": proof_header})

    print(f"Step 7: Response status={retry_resp.status_code}")
    print(f"  X402-Receipt: {retry_resp.headers.get('X402-Receipt', '')}")
    print(f"  X402-Status: {retry_resp.headers.get('X402-Status', '')}")
    print(f"  Body: {retry_resp.text}")


if __name__ == "__main__":
    main()
