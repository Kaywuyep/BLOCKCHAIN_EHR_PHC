package main

import (
	"log"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// main packages PatientRegistry, AccessControl, AuditLog and CostMetrics
// as one deployable chaincode (one chaincode container per peer), while
// keeping each concern in its own contract/file -- matching the three
// chaincode contracts described in Section 3.5, plus the metrics counters
// used for the transaction-optimisation demo in Section 3.5.2.
//
// Fabric namespaces functions by contract name automatically, so client
// invocations look like:
//
//	peer chaincode invoke -c '{"function":"AccessControlContract:GrantAccess","Args":[...]}'
func main() {
	cc, err := contractapi.NewChaincode(
		&PatientRegistryContract{},
		&AccessControlContract{},
		&AuditLogContract{},
		&CostMetricsContract{},
	)
	if err != nil {
		log.Panicf("Error creating patientchain chaincode: %v", err)
	}
	cc.Info.Title = "PatientChain"
	cc.Info.Version = "0.1.0"

	if err := cc.Start(); err != nil {
		log.Panicf("Error starting patientchain chaincode: %v", err)
	}
}
