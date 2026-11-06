package main

import "time"

// Timestamps are stored on-chain as RFC 3339 strings rather than time.Time.
// fabric-contract-api-go builds a JSON schema for every type a contract
// function returns, and time.Time (a struct with no exported fields)
// produces an object schema with an empty "required" array, which the
// contract runtime rejects at start-up ("components.schemas.Time.required:
// Array must have at least 1 items"). The chaincode then cannot launch on a
// real peer at all. Strings avoid that, and serialise to exactly the same
// JSON the backend already expects.

func formatTS(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}

func parseTS(s string) (time.Time, error) {
	return time.Parse(time.RFC3339Nano, s)
}
