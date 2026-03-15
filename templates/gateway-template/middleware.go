package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// GatekeeperConfig configures the x402 payment gating middleware.
type GatekeeperConfig struct {
	// PayeeLockingScriptHex is the hex P2PKH locking script receiving payments.
	PayeeLockingScriptHex string

	// AmountSats is the price per request in satoshis.
	AmountSats int64

	// ChallengeTTL is how long a challenge remains valid.
	ChallengeTTL time.Duration
}

// Challenge is the 402 payment challenge (per x402 protocol spec).
type Challenge struct {
	V                     string `json:"v"`
	Scheme                string `json:"scheme"`
	AmountSats            int64  `json:"amount_sats"`
	PayeeLockingScriptHex string `json:"payee_locking_script_hex"`
	ExpiresAt             int64  `json:"expires_at"`
	Domain                string `json:"domain"`
	Method                string `json:"method"`
	Path                  string `json:"path"`
	Query                 string `json:"query"`
	ReqHeadersSHA256      string `json:"req_headers_sha256"`
	ReqBodySHA256         string `json:"req_body_sha256"`
	RequireMempoolAccept  bool   `json:"require_mempool_accept"`
	ConfirmationsRequired int    `json:"confirmations_required"`
}

// Header allowlist for request binding hash (per x402 spec).
var headerAllowlist = []string{
	"accept",
	"content-length",
	"content-type",
	"x402-client",
	"x402-idempotency-key",
}

// In-memory challenge cache. Use Redis in production.
var challenges = struct {
	sync.RWMutex
	m map[string]*Challenge
}{m: make(map[string]*Challenge)}

// X402Middleware returns HTTP middleware that gates access behind x402 payment.
func X402Middleware(cfg GatekeeperConfig) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			proof := r.Header.Get("X402-Proof")
			if proof == "" {
				issueChallenge(w, r, cfg)
				return
			}
			verifyAndServe(w, r, next, proof, cfg)
		})
	}
}

func issueChallenge(w http.ResponseWriter, r *http.Request, cfg GatekeeperConfig) {
	// TODO: Lease nonce UTXO from pool (see operate-nonce-mint skill)
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
		ReqHeadersSHA256:      hashRequestHeaders(r),
		ReqBodySHA256:         hashEmpty(),
		RequireMempoolAccept:  true,
		ConfirmationsRequired: 0,
	}

	data, _ := json.Marshal(ch)
	h := sha256.Sum256(data)
	hash := hex.EncodeToString(h[:])

	challenges.Lock()
	challenges.m[hash] = ch
	challenges.Unlock()

	w.Header().Set("X402-Challenge", base64.RawURLEncoding.EncodeToString(data))
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
	proofBytes, err := base64.RawURLEncoding.DecodeString(proofHeader)
	if err != nil {
		writeJSON(w, 400, "invalid_proof", "cannot decode proof")
		return
	}

	var proof struct {
		V               string `json:"v"`
		Scheme          string `json:"scheme"`
		TxID            string `json:"txid"`
		ChallengeSHA256 string `json:"challenge_sha256"`
		Request         struct {
			Domain string `json:"domain"`
			Method string `json:"method"`
			Path   string `json:"path"`
			Query  string `json:"query"`
		} `json:"request"`
	}
	if err := json.Unmarshal(proofBytes, &proof); err != nil {
		writeJSON(w, 400, "invalid_proof", "cannot parse proof")
		return
	}

	if proof.V != "1" || proof.Scheme != "bsv-tx-v1" {
		writeJSON(w, 400, "invalid_scheme", "unsupported version or scheme")
		return
	}

	challenges.RLock()
	ch, ok := challenges.m[proof.ChallengeSHA256]
	challenges.RUnlock()
	if !ok {
		writeJSON(w, 400, "challenge_not_found", "challenge not found or expired")
		return
	}

	if ch.ExpiresAt <= time.Now().Unix() {
		writeJSON(w, 402, "expired_challenge", "challenge expired")
		return
	}

	if proof.Request.Domain != r.Host || proof.Request.Method != r.Method ||
		proof.Request.Path != r.URL.Path || proof.Request.Query != r.URL.RawQuery {
		writeJSON(w, 403, "invalid_binding", "request binding mismatch")
		return
	}

	// TODO: Verify nonce spend, payee output, mempool acceptance
	// See skills/server/verify-payment-proof.md for complete 16-step verification

	receipt := sha256.Sum256([]byte(proof.TxID + ":" + proof.ChallengeSHA256))

	challenges.Lock()
	delete(challenges.m, proof.ChallengeSHA256)
	challenges.Unlock()

	w.Header().Set("X402-Receipt", hex.EncodeToString(receipt[:]))
	w.Header().Set("X402-Status", "accepted")
	next.ServeHTTP(w, r)
}

func hashRequestHeaders(r *http.Request) string {
	sorted := make([]string, len(headerAllowlist))
	copy(sorted, headerAllowlist)
	sort.Strings(sorted)

	var parts []string
	for _, key := range sorted {
		value := strings.TrimSpace(r.Header.Get(key))
		value = strings.Join(strings.Fields(value), " ")
		parts = append(parts, fmt.Sprintf("%s:%s", key, value))
	}
	canonical := strings.Join(parts, "\n")
	if len(parts) > 0 {
		canonical += "\n"
	}
	h := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(h[:])
}

func hashEmpty() string {
	h := sha256.Sum256([]byte(""))
	return hex.EncodeToString(h[:])
}

func writeJSON(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"status": status, "code": code, "message": message})
}
