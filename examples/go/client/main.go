// x402 Client Example
//
// Demonstrates the x402 payment flow:
// 1. Send request → receive 402 + challenge
// 2. Parse challenge → build partial tx
// 3. Submit to delegator → receive completed tx
// 4. Broadcast tx → retry with proof
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// Challenge represents the x402 402 challenge (per protocol spec).
type Challenge struct {
	V                     string    `json:"v"`
	Scheme                string    `json:"scheme"`
	AmountSats            int64     `json:"amount_sats"`
	PayeeLockingScriptHex string    `json:"payee_locking_script_hex"`
	ExpiresAt             int64     `json:"expires_at"`
	Domain                string    `json:"domain"`
	Method                string    `json:"method"`
	Path                  string    `json:"path"`
	Query                 string    `json:"query"`
	ReqHeadersSHA256      string    `json:"req_headers_sha256"`
	ReqBodySHA256         string    `json:"req_body_sha256"`
	NonceUTXO             *NonceRef `json:"nonce_utxo,omitempty"`
	Template              *TemplateRef `json:"template,omitempty"`
	RequireMempoolAccept  bool      `json:"require_mempool_accept"`
	ConfirmationsRequired int       `json:"confirmations_required"`
}

type NonceRef struct {
	TxID             string `json:"txid"`
	Vout             uint32 `json:"vout"`
	Satoshis         uint64 `json:"satoshis"`
	LockingScriptHex string `json:"locking_script_hex"`
}

type TemplateRef struct {
	RawTxHex  string `json:"rawtx_hex"`
	PriceSats uint64 `json:"price_sats"`
}

// DelegationRequest is sent to POST /delegate/x402.
type DelegationRequest struct {
	PartialTx    string       `json:"partial_tx"`
	ChallengeHash string      `json:"challenge_hash"`
	PayeeScript  string       `json:"payee_locking_script_hex,omitempty"`
	AmountSats   int64        `json:"amount_sats,omitempty"`
	NonceOutpoint *NonceOutpoint `json:"nonce_outpoint,omitempty"`
	TemplateMode bool         `json:"template_mode,omitempty"`
}

type NonceOutpoint struct {
	TxID     string `json:"txid"`
	Vout     uint32 `json:"vout"`
	Satoshis uint64 `json:"satoshis,omitempty"`
}

// DelegationResult is returned by the delegator.
type DelegationResult struct {
	TxID        string `json:"txid"`
	CompletedTx string `json:"completed_tx"`
	RawTxHex    string `json:"rawtx_hex"`
}

// Proof is the x402 payment proof sent in X402-Proof header.
type Proof struct {
	V              string         `json:"v"`
	Scheme         string         `json:"scheme"`
	TxID           string         `json:"txid"`
	RawTxB64       string         `json:"rawtx_b64"`
	ChallengeSHA256 string        `json:"challenge_sha256"`
	Request        RequestBinding `json:"request"`
}

type RequestBinding struct {
	Domain           string `json:"domain"`
	Method           string `json:"method"`
	Path             string `json:"path"`
	Query            string `json:"query"`
	ReqHeadersSHA256 string `json:"req_headers_sha256"`
	ReqBodySHA256    string `json:"req_body_sha256"`
}

func main() {
	targetURL := envOrDefault("TARGET_URL", "http://localhost:8402/v1/expensive")
	delegatorURL := envOrDefault("DELEGATOR_URL", "http://localhost:8402/delegate/x402")

	log.Println("Step 1: Sending initial request...")
	resp, err := http.Get(targetURL)
	if err != nil {
		log.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusPaymentRequired {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("Got status %d (not 402): %s", resp.StatusCode, body)
		return
	}

	// Step 2: Parse 402 challenge
	challengeHeader := resp.Header.Get("X402-Challenge")
	if challengeHeader == "" {
		log.Fatal("402 response missing X402-Challenge header")
	}

	log.Println("Step 2: Parsing challenge...")
	challenge, challengeHash, err := parseChallenge(challengeHeader)
	if err != nil {
		log.Fatalf("parse challenge: %v", err)
	}

	log.Printf("  scheme=%s amount=%d sats expires=%d", challenge.Scheme, challenge.AmountSats, challenge.ExpiresAt)
	log.Printf("  nonce=%s:%d", challenge.NonceUTXO.TxID, challenge.NonceUTXO.Vout)

	// Step 3: Check expiry
	if challenge.ExpiresAt > 0 && challenge.ExpiresAt < time.Now().Unix() {
		log.Fatal("challenge expired")
	}

	// Step 4: Build partial transaction
	log.Println("Step 3: Building partial transaction...")
	var partialTxHex string
	templateMode := false
	if challenge.Template != nil && challenge.Template.RawTxHex != "" {
		// Profile B: use pre-signed template
		partialTxHex = challenge.Template.RawTxHex
		templateMode = true
		log.Println("  using Profile B (gateway template)")
	} else {
		// Profile A: build unsigned partial tx
		partialTxHex = buildUnsignedPartialTx(challenge.NonceUTXO, challenge.PayeeLockingScriptHex, challenge.AmountSats)
		log.Println("  using Profile A (open nonce)")
	}

	// Step 5: Submit to delegator
	log.Println("Step 4: Submitting to delegator...")
	delegReq := DelegationRequest{
		PartialTx:     partialTxHex,
		ChallengeHash: challengeHash,
		PayeeScript:   challenge.PayeeLockingScriptHex,
		AmountSats:    challenge.AmountSats,
		NonceOutpoint: &NonceOutpoint{
			TxID:     challenge.NonceUTXO.TxID,
			Vout:     challenge.NonceUTXO.Vout,
			Satoshis: challenge.NonceUTXO.Satoshis,
		},
		TemplateMode: templateMode,
	}

	delegResult, err := delegate(delegatorURL, delegReq)
	if err != nil {
		log.Fatalf("delegation failed: %v", err)
	}
	log.Printf("  delegator returned txid=%s", delegResult.TxID)

	// Step 6: Broadcast transaction
	rawtx := delegResult.CompletedTx
	if rawtx == "" {
		rawtx = delegResult.RawTxHex
	}
	log.Println("Step 5: Broadcasting transaction...")
	// In production, broadcast to BSV network via WhatsOnChain or ARC
	// broadcastTx(rawtx)

	// Step 7: Build proof and retry
	log.Println("Step 6: Retrying with proof...")
	rawtxBytes, _ := hex.DecodeString(rawtx)
	proof := Proof{
		V:               "1",
		Scheme:          "bsv-tx-v1",
		TxID:            delegResult.TxID,
		RawTxB64:        base64.StdEncoding.EncodeToString(rawtxBytes),
		ChallengeSHA256: challengeHash,
		Request: RequestBinding{
			Domain: challenge.Domain,
			Method: challenge.Method,
			Path:   challenge.Path,
			Query:  challenge.Query,
			ReqHeadersSHA256: challenge.ReqHeadersSHA256,
			ReqBodySHA256:    challenge.ReqBodySHA256,
		},
	}

	proofJSON, _ := json.Marshal(proof)
	proofHeader := base64.RawURLEncoding.EncodeToString(proofJSON)

	req, _ := http.NewRequest("GET", targetURL, nil)
	req.Header.Set("X402-Proof", proofHeader)

	retryResp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Fatalf("retry failed: %v", err)
	}
	defer retryResp.Body.Close()

	body, _ := io.ReadAll(retryResp.Body)
	log.Printf("Step 7: Response status=%d", retryResp.StatusCode)
	log.Printf("  X402-Receipt: %s", retryResp.Header.Get("X402-Receipt"))
	log.Printf("  X402-Status: %s", retryResp.Header.Get("X402-Status"))
	log.Printf("  Body: %s", string(body))
}

// parseChallenge decodes the X402-Challenge header value.
func parseChallenge(headerValue string) (*Challenge, string, error) {
	payload := headerValue

	// Strip compact prefix if present: "v1.bsv-tx.<base64url>"
	if parts := strings.SplitN(payload, ".", 3); len(parts) == 3 {
		payload = parts[2]
	}

	rawBytes, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return nil, "", fmt.Errorf("base64url decode: %w", err)
	}

	h := sha256.Sum256(rawBytes)
	challengeHash := hex.EncodeToString(h[:])

	var ch Challenge
	if err := json.Unmarshal(rawBytes, &ch); err != nil {
		return nil, "", fmt.Errorf("json unmarshal: %w", err)
	}

	if ch.NonceUTXO == nil {
		return nil, "", fmt.Errorf("challenge missing nonce_utxo")
	}

	return &ch, challengeHash, nil
}

// buildUnsignedPartialTx constructs a minimal unsigned BSV transaction.
// Profile A: 1 input (nonce UTXO) + 1 output (payee payment).
func buildUnsignedPartialTx(nonce *NonceRef, lockingScriptHex string, amountSats int64) string {
	var buf bytes.Buffer

	// Version (4 LE)
	writeUint32LE(&buf, 1)

	// Input count
	buf.WriteByte(1)

	// Previous output hash (reversed txid bytes)
	txidBytes, _ := hex.DecodeString(nonce.TxID)
	reverseBytes(txidBytes)
	buf.Write(txidBytes)

	// Previous output index (4 LE)
	writeUint32LE(&buf, nonce.Vout)

	// ScriptSig length (0 — unsigned)
	buf.WriteByte(0)

	// Sequence
	writeUint32LE(&buf, 0xffffffff)

	// Output count
	buf.WriteByte(1)

	// Value (8 LE)
	writeUint64LE(&buf, uint64(amountSats))

	// Locking script
	script, _ := hex.DecodeString(lockingScriptHex)
	buf.WriteByte(byte(len(script)))
	buf.Write(script)

	// Locktime (4 LE)
	writeUint32LE(&buf, 0)

	return hex.EncodeToString(buf.Bytes())
}

func delegate(url string, req DelegationRequest) (*DelegationResult, error) {
	body, _ := json.Marshal(req)
	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("delegator returned %d: %s", resp.StatusCode, errBody)
	}

	var result DelegationResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &result, nil
}

func writeUint32LE(buf *bytes.Buffer, v uint32) {
	b := [4]byte{byte(v), byte(v >> 8), byte(v >> 16), byte(v >> 24)}
	buf.Write(b[:])
}

func writeUint64LE(buf *bytes.Buffer, v uint64) {
	b := [8]byte{
		byte(v), byte(v >> 8), byte(v >> 16), byte(v >> 24),
		byte(v >> 32), byte(v >> 40), byte(v >> 48), byte(v >> 56),
	}
	buf.Write(b[:])
}

func reverseBytes(b []byte) {
	for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
		b[i], b[j] = b[j], b[i]
	}
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
