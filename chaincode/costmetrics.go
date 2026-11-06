package main

import (
	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// CostMetricsContract exposes the raw event counters that the backend's
// cost-model service (Section 3.5.2) uses to compute λr, λg, λa and ledger
// growth dG/dt. The chaincode itself only counts events; the arithmetic
// from the model (Caction(b), Ledger_rate, etc.) is computed off-chain in
// the backend so the on-chain cost of *tracking* the cost model stays
// negligible.
type CostMetricsContract struct {
	contractapi.Contract
}

// GetCounters returns the raw lifetime counts for each event category.
func (c *CostMetricsContract) GetCounters(ctx contractapi.TransactionContextInterface) (map[string]int, error) {
	counters := map[string]int{}
	for _, cat := range counterCategories {
		v, err := countEvents(ctx, cat)
		if err != nil {
			return nil, err
		}
		counters[cat] = v
	}
	return counters, nil
}

var counterCategories = []string{"reference", "grant", "audit", "registration", "breakglass"}

// counterObjectType namespaces the per-event marker keys.
const counterObjectType = "costevent"

// bumpCostCounter records one event by writing its own marker key,
// costevent~<category>~<txID>, instead of reading and incrementing a single
// shared counter. A shared counter is a write hotspot: every transaction of
// a category reads and writes the same key, so when two of them land in the
// same block Fabric's MVCC validation keeps the first and invalidates the
// rest (MVCC_READ_CONFLICT). That made concurrent patient actions fail and
// defeated the batching the cost model depends on. Marker keys are
// write-only and unique per transaction, so they never conflict. Each
// contract function bumps a given category at most once, so the txID alone
// makes the key unique.
func bumpCostCounter(ctx contractapi.TransactionContextInterface, category string) error {
	key, err := ctx.GetStub().CreateCompositeKey(counterObjectType, []string{category, ctx.GetStub().GetTxID()})
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(key, []byte{0x01})
}

// countEvents counts a category's marker keys. This is a range scan, which
// is fine for a pilot-scale ledger; a production deployment would roll the
// markers up into periodic snapshots.
func countEvents(ctx contractapi.TransactionContextInterface, category string) (int, error) {
	iter, err := ctx.GetStub().GetStateByPartialCompositeKey(counterObjectType, []string{category})
	if err != nil {
		return 0, err
	}
	defer iter.Close()
	n := 0
	for iter.HasNext() {
		if _, err := iter.Next(); err != nil {
			return 0, err
		}
		n++
	}
	return n, nil
}
