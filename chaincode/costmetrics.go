package main

import (
	"strconv"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
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
	categories := []string{"reference", "grant", "audit", "registration", "breakglass"}
	counters := map[string]int{}
	for _, cat := range categories {
		v, err := readCounter(ctx, cat)
		if err != nil {
			return nil, err
		}
		counters[cat] = v
	}
	return counters, nil
}

func bumpCostCounter(ctx contractapi.TransactionContextInterface, category string) error {
	current, err := readCounter(ctx, category)
	if err != nil {
		return err
	}
	current++
	return ctx.GetStub().PutState(counterKey(category), []byte(strconv.Itoa(current)))
}

func readCounter(ctx contractapi.TransactionContextInterface, category string) (int, error) {
	data, err := ctx.GetStub().GetState(counterKey(category))
	if err != nil {
		return 0, err
	}
	if data == nil {
		return 0, nil
	}
	v, err := strconv.Atoi(string(data))
	if err != nil {
		return 0, err
	}
	return v, nil
}

func counterKey(category string) string {
	return "COUNTER_" + category
}
