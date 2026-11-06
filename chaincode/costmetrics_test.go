package main

import (
	"testing"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

func newCostMetricsCtx() (*CostMetricsContract, *contractapi.TransactionContext, *fakeStub) {
	stub := newFakeStub()
	ctx := &contractapi.TransactionContext{}
	ctx.SetStub(stub)
	return &CostMetricsContract{}, ctx, stub
}

func TestGetCountersStartsAtZero(t *testing.T) {
	c, ctx, _ := newCostMetricsCtx()

	counters, err := c.GetCounters(ctx)
	if err != nil {
		t.Fatalf("GetCounters returned error: %v", err)
	}
	for _, cat := range []string{"reference", "grant", "audit", "registration", "breakglass"} {
		if counters[cat] != 0 {
			t.Errorf("expected %s counter to start at 0, got %d", cat, counters[cat])
		}
	}
}

func TestBumpCostCounterIncrements(t *testing.T) {
	c, ctx, stub := newCostMetricsCtx()

	// Each bump happens in its own transaction, as it does on a peer.
	stub.txID = "tx-1"
	if err := bumpCostCounter(ctx, "grant"); err != nil {
		t.Fatalf("bumpCostCounter returned error: %v", err)
	}
	stub.txID = "tx-2"
	if err := bumpCostCounter(ctx, "grant"); err != nil {
		t.Fatalf("bumpCostCounter returned error: %v", err)
	}
	if err := bumpCostCounter(ctx, "audit"); err != nil {
		t.Fatalf("bumpCostCounter returned error: %v", err)
	}

	counters, err := c.GetCounters(ctx)
	if err != nil {
		t.Fatalf("GetCounters returned error: %v", err)
	}
	if counters["grant"] != 2 {
		t.Errorf("expected grant counter to be 2, got %d", counters["grant"])
	}
	if counters["audit"] != 1 {
		t.Errorf("expected audit counter to be 1, got %d", counters["audit"])
	}
	if counters["reference"] != 0 {
		t.Errorf("expected untouched reference counter to remain 0, got %d", counters["reference"])
	}
}

// TestBumpCostCounterNeverReadsSharedState guards against reintroducing a
// read-modify-write hotspot: concurrent transactions that read the same key
// fail MVCC validation on a real peer when they share a block.
func TestBumpCostCounterNeverReadsSharedState(t *testing.T) {
	_, ctx, stub := newCostMetricsCtx()
	stub.txID = "tx-hot"
	stub.reads = 0
	if err := bumpCostCounter(ctx, "grant"); err != nil {
		t.Fatalf("bumpCostCounter returned error: %v", err)
	}
	if stub.reads != 0 {
		t.Errorf("bumpCostCounter read %d key(s); it must be write-only to avoid MVCC conflicts", stub.reads)
	}
}
