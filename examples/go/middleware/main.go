// x402 Gateway Middleware Example
//
// Demonstrates the gatekeeper pattern: HTTP middleware that issues
// 402 challenges for unauthenticated requests and verifies payment
// proofs on retry.
package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Challenge JSON structure (per x402 protocol spec).
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
	RequireMempoolAccept  bool      `json:"require_mempool_accept"`
	ConfirmationsRequired int       `json:"confirmations_required"`
}

type NonceRef struct {
	TxID             string `json:"txid"`
	Vout             uint32 `json:"vout"`
	Satoshis         uint64 `json:"satoshis"`
	LockingScriptHex string `json:"locking_script_hex"`
}

// GatekeeperConfig configures the x402 middleware.
type GatekeeperConfig struct {
	PayeeLockingScriptHex string
	AmountSats            int64
	ChallengeTTL          time.Duration
}

// challengeCache stores issued challenges for proof verification.
var challengeCache = struct {
	sync.RWMutex
	m map[string]*Challenge
}{m: make(map[string]*Challenge)}

// Header allowlist for request binding hash.
var headerAllowlist = []string{
	"accept",
	"content-length",
	"content-type",
	"x402-client",
	"x402-idempotency-key",
}

// X402Middleware gates HTTP handlers behind x402 payment.
func X402Middleware(cfg GatekeeperConfig) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			proofHeader := r.Header.Get("X402-Proof")

			if proofHeader == "" {
				issueChallenge(w, r, cfg)
				return
			}

			verifyAndServe(w, r, next, proofHeader, cfg)
		})
	}
}

func issueChallenge(w http.ResponseWriter, r *http.Request, cfg GatekeeperConfig) {
	ch := &Challenge{
		V:                     "1",
		Scheme:                "bsv-tx-v1",
		AmountSats:            cfg.AmountSats,
		PayeeLockingScriptHex: cfg.PayeeLockingScriptHex,
		ExpiresAt:             time.Now().Add(cfg.ChallengeTTL).Unix(),
		Domain:                r.Host,
		Method:                r.Method,
		Path:                  r.URL.Path,
		Query:                 r.URL.RawQuery,
		ReqHeadersSHA256:      hashHeaders(r),
		ReqBodySHA256:         hashEmptyBody(),
		RequireMempoolAccept:  true,
		ConfirmationsRequired: 0,
		// NonceUTXO would be leased from pool in production
	}

	challengeJSON, _ := json.Marshal(ch)

	h := sha256.Sum256(challengeJSON)
	challengeHash := hex.EncodeToString(h[:])

	challengeCache.Lock()
	challengeCache.m[challengeHash] = ch
	challengeCache.Unlock()

	encoded := base64.RawURLEncoding.EncodeToString(challengeJSON)

	w.Header().Set("X402-Challenge", encoded)
	w.Header().Set("X402-Accept", "bsv-tx-v1")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusPaymentRequired)
	json.NewEncoder(w).Encode(map[string]any{
		"status":  402,
		"code":    "payment_required",
		"message": "Payment required. See X402-Challenge header.",
	})
}

func verifyAndServe(w http.ResponseWriter, r *http.Request, next http.Handler, proofHeader string, cfg GatekeeperConfig) {
	// In production: full 16-step verification (see verify-payment-proof skill)
	// This example shows the structure without full tx parsing.

	proofBytes, err := base64.RawURLEncoding.DecodeString(proofHeader)
	if err != nil {
		writeError(w, 400, "invalid_proof", "cannot decode proof")
		return
	}

	var proof struct {
		V               string `json:"v"`
		Scheme          string `json:"scheme"`
		TxID            string `json:"txid"`
		RawTxB64        string `json:"rawtx_b64"`
		ChallengeSHA256 string `json:"challenge_sha256"`
		Request         struct {
			Domain           string `json:"domain"`
			Method           string `json:"method"`
			Path             string `json:"path"`
			Query            string `json:"query"`
			ReqHeadersSHA256 string `json:"req_headers_sha256"`
			ReqBodySHA256    string `json:"req_body_sha256"`
		} `json:"request"`
	}
	if err := json.Unmarshal(proofBytes, &proof); err != nil {
		writeError(w, 400, "invalid_proof", "cannot parse proof JSON")
		return
	}

	if proof.V != "1" || proof.Scheme != "bsv-tx-v1" {
		writeError(w, 400, "invalid_scheme", "unsupported version or scheme")
		return
	}

	// Look up original challenge
	challengeCache.RLock()
	originalChallenge, found := challengeCache.m[proof.ChallengeSHA256]
	challengeCache.RUnlock()

	if !found {
		writeError(w, 400, "challenge_not_found", "challenge not found or expired")
		return
	}

	// Check expiry
	if originalChallenge.ExpiresAt <= time.Now().Unix() {
		writeError(w, 402, "expired_challenge", "challenge has expired")
		return
	}

	// Verify request binding
	if proof.Request.Domain != r.Host ||
		proof.Request.Method != r.Method ||
		proof.Request.Path != r.URL.Path ||
		proof.Request.Query != r.URL.RawQuery {
		writeError(w, 403, "invalid_binding", "request binding mismatch")
		return
	}

	// In production: verify nonce spend, payee output, mempool acceptance
	// (see verify-payment-proof.md and validate-proof.md skills)

	// Compute receipt
	receiptInput := proof.TxID + ":" + proof.ChallengeSHA256
	receiptHash := sha256.Sum256([]byte(receiptInput))

	// Delete challenge (single-use)
	challengeCache.Lock()
	delete(challengeCache.m, proof.ChallengeSHA256)
	challengeCache.Unlock()

	w.Header().Set("X402-Receipt", hex.EncodeToString(receiptHash[:]))
	w.Header().Set("X402-Status", "accepted")
	next.ServeHTTP(w, r)
}

func hashHeaders(r *http.Request) string {
	sorted := make([]string, len(headerAllowlist))
	copy(sorted, headerAllowlist)
	sort.Strings(sorted)

	var parts []string
	for _, key := range sorted {
		value := strings.TrimSpace(r.Header.Get(key))
		value = collapseWhitespace(value)
		parts = append(parts, fmt.Sprintf("%s:%s", key, value))
	}

	canonical := strings.Join(parts, "\n")
	if len(parts) > 0 {
		canonical += "\n"
	}

	h := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(h[:])
}

func hashEmptyBody() string {
	h := sha256.Sum256([]byte(""))
	return hex.EncodeToString(h[:])
}

func collapseWhitespace(s string) string {
	fields := strings.Fields(s)
	return strings.Join(fields, " ")
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{
		"status":  status,
		"code":    code,
		"message": message,
	})
}

func main() {
	cfg := GatekeeperConfig{
		PayeeLockingScriptHex: "76a914000000000000000000000000000000000000000088ac", // placeholder P2PKH
		AmountSats:            100,
		ChallengeTTL:          5 * time.Minute,
	}

	mux := http.NewServeMux()

	// Protected endpoint
	protected := X402Middleware(cfg)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"data":    "premium content",
			"message": "Payment verified. Access granted.",
		})
	}))
	mux.Handle("/v1/expensive", protected)

	// Health check (unprotected)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	log.Println("x402 gateway listening on :8402")
	log.Fatal(http.ListenAndServe(":8402", mux))
}
