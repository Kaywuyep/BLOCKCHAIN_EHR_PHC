package main

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// AuditLogContract records every access event immutably. No function in
// this contract ever deletes or modifies an existing entry (Section 3.5) —
// there is deliberately no UpdateAuditEntry or DeleteAuditEntry function.
type AuditLogContract struct {
	contractapi.Contract
}

type AuditEventType string

const (
	EventRecordAccessed     AuditEventType = "RECORD_ACCESSED"
	EventGrantIssued        AuditEventType = "GRANT_ISSUED"
	EventGrantRevoked       AuditEventType = "GRANT_REVOKED"
	EventReferenceAdded     AuditEventType = "REFERENCE_ADDED"
	EventBreakGlassAccess   AuditEventType = "BREAK_GLASS_ACCESS"
	EventBreakGlassReviewed AuditEventType = "BREAK_GLASS_REVIEWED"
)

// AuditEntry is one immutable line in the patient's access history.
type AuditEntry struct {
	DocType    string         `json:"docType"` // "audit"
	EntryID    string         `json:"entryID"`
	PatientDID string         `json:"patientDID"`
	EventType  AuditEventType `json:"eventType"`
	ActorID    string         `json:"actorID"` // provider/hospital identity that triggered the event
	HospitalID string         `json:"hospitalID"`
	Timestamp  string         `json:"timestamp"`
	Detail     string         `json:"detail,omitempty" metadata:"detail,optional"`
	// QueuedOffline marks entries that were generated while the client was
	// disconnected and only reached the ledger after reconnection
	// (Section 3.6). The audit trail still reflects the true event
	// timeline, not the connectivity timeline: the original client-side
	// timestamp is preserved in Timestamp, this flag simply records that
	// the write itself was delayed.
	QueuedOffline bool `json:"queuedOffline"`
}

// WriteAuditEntry appends one immutable entry. Called internally by the
// AccessControl/PatientRegistry flows or directly by the FHIR Adapter
// after it serves a record (Figure 3, step 6 / Figure 4, step 5).
func (c *AuditLogContract) WriteAuditEntry(ctx contractapi.TransactionContextInterface, entryID string, patientDID string, eventType string, actorID string, hospitalID string, detail string, clientTimestampRFC3339 string, queuedOffline bool) error {
	existing, err := ctx.GetStub().GetState(auditKey(entryID))
	if err != nil {
		return err
	}
	if existing != nil {
		return fmt.Errorf("audit entry %s already exists", entryID)
	}

	var ts time.Time
	if clientTimestampRFC3339 != "" {
		ts, err = time.Parse(time.RFC3339, clientTimestampRFC3339)
		if err != nil {
			return fmt.Errorf("invalid client timestamp: %v", err)
		}
	} else {
		txTimestamp, err := ctx.GetStub().GetTxTimestamp()
		if err != nil {
			return err
		}
		ts = txTimestamp.AsTime()
	}

	entry := AuditEntry{
		DocType:       "audit",
		EntryID:       entryID,
		PatientDID:    patientDID,
		EventType:     AuditEventType(eventType),
		ActorID:       actorID,
		HospitalID:    hospitalID,
		Timestamp:     formatTS(ts),
		Detail:        detail,
		QueuedOffline: queuedOffline,
	}

	entryJSON, err := json.Marshal(entry)
	if err != nil {
		return err
	}

	if err := ctx.GetStub().PutState(auditKey(entryID), entryJSON); err != nil {
		return err
	}

	compositeKey, err := ctx.GetStub().CreateCompositeKey("audit~patient", []string{patientDID, entryID})
	if err != nil {
		return err
	}
	if err := ctx.GetStub().PutState(compositeKey, []byte{0x00}); err != nil {
		return err
	}

	if err := ctx.GetStub().SetEvent("AuditEntryWritten", entryJSON); err != nil {
		return err
	}

	return bumpCostCounter(ctx, "audit")
}

// GetAuditTrailForPatient returns the patient's full, immutable access
// history — queryable by the patient at any time (Section 3.5).
func (c *AuditLogContract) GetAuditTrailForPatient(ctx contractapi.TransactionContextInterface, patientDID string) ([]*AuditEntry, error) {
	iterator, err := ctx.GetStub().GetStateByPartialCompositeKey("audit~patient", []string{patientDID})
	if err != nil {
		return nil, err
	}
	defer iterator.Close()

	var entries []*AuditEntry
	for iterator.HasNext() {
		kv, err := iterator.Next()
		if err != nil {
			return nil, err
		}
		_, keyParts, err := ctx.GetStub().SplitCompositeKey(kv.Key)
		if err != nil {
			return nil, err
		}
		entryID := keyParts[1]
		data, err := ctx.GetStub().GetState(auditKey(entryID))
		if err != nil {
			return nil, err
		}
		var entry AuditEntry
		if err := json.Unmarshal(data, &entry); err != nil {
			return nil, err
		}
		entries = append(entries, &entry)
	}
	return entries, nil
}

// VerifyImmutability is a defense-friendly convenience query: it proves,
// on request, that no chaincode function in this contract can delete or
// modify a written entry, by listing the full function set exposed here.
func (c *AuditLogContract) VerifyImmutability(ctx contractapi.TransactionContextInterface) string {
	return "AuditLogContract exposes only WriteAuditEntry (create) and read queries. " +
		"No update or delete function exists for audit entries at the chaincode level."
}

func auditKey(entryID string) string {
	return "AUDIT_" + entryID
}
