// x402 Discovery Endpoint Example (Go)
//
// Serves GET /.well-known/x402 returning a JSON document that enumerates
// all x402-payable endpoints offered by this service.
//
// Usage:
//   go run main.go
//   curl http://localhost:8402/.well-known/x402

package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

// ---------------------------------------------------------------------------
// Discovery document types
// ---------------------------------------------------------------------------

type DiscoveryDocument struct {
	Protocol  string              `json:"protocol"`
	Version   string              `json:"version"`
	Service   string              `json:"service"`
	Endpoints []EndpointDescriptor `json:"endpoints"`
}

type EndpointDescriptor struct {
	Path        string `json:"path"`
	Method      string `json:"method"`
	PriceSats   int64  `json:"price_sats"`
	Currency    string `json:"currency"`
	Acceptance  string `json:"acceptance"`
	Description string `json:"description,omitempty"`
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

func buildDiscoveryDocument() DiscoveryDocument {
	return DiscoveryDocument{
		Protocol: "x402",
		Version:  "1.0",
		Service:  "Example x402 API",
		Endpoints: []EndpointDescriptor{
			{
				Path:        "/v1/data",
				Method:      "GET",
				PriceSats:   5,
				Currency:    "BSV",
				Acceptance:  "mempool",
				Description: "Retrieve premium dataset",
			},
			{
				Path:        "/v1/compute",
				Method:      "POST",
				PriceSats:   50,
				Currency:    "BSV",
				Acceptance:  "mempool",
				Description: "Run computation job",
			},
			{
				Path:        "/v1/image",
				Method:      "GET",
				PriceSats:   10,
				Currency:    "BSV",
				Acceptance:  "mempool",
				Description: "Generate image",
			},
		},
	}
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

func discoveryHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	doc := buildDiscoveryDocument()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.WriteHeader(http.StatusOK)

	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.Encode(doc)
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"ok"}`))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8402"
	}

	http.HandleFunc("/.well-known/x402", discoveryHandler)
	http.HandleFunc("/health", healthHandler)

	log.Printf("x402 discovery endpoint listening on :%s", port)
	log.Printf("  GET http://localhost:%s/.well-known/x402", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
