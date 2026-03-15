// x402 Gateway Template
//
// Scaffold for an x402 payment-gated HTTP API.
// Replace placeholder values with your configuration.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	listenAddr := envOrDefault("LISTEN_ADDR", ":8402")
	payeeScript := envOrDefault("PAYEE_LOCKING_SCRIPT_HEX", "76a914000000000000000000000000000000000000000088ac")
	amountSats := int64(100) // Configure per endpoint

	cfg := GatekeeperConfig{
		PayeeLockingScriptHex: payeeScript,
		AmountSats:            amountSats,
		ChallengeTTL:          5 * time.Minute,
	}

	mux := http.NewServeMux()

	// Protected endpoint — requires x402 payment
	mux.Handle("/v1/resource", X402Middleware(cfg)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"data": "your protected response",
		})
	})))

	// Health check — unprotected
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	// TODO: Add delegator endpoint at POST /delegate/x402
	// TODO: Add nonce pool management
	// TODO: Add fee pool management
	// See skills/infrastructure/ for implementation guidance

	log.Printf("x402 gateway listening on %s", listenAddr)
	log.Fatal(http.ListenAndServe(listenAddr, mux))
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
