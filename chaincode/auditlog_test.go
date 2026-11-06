package main

import (
	"testing"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

func newAuditLogCtx() (*AuditLogContract, *contractapi.TransactionContext, *fakeStub) {
	stub := newFakeStub()
	ctx := &contractapi.TransactionContext{}
	ctx.SetStub(stub)
	return &AuditLogContract{}, ctx, stub
}

func TestWriteAuditEntryUsesClientTimestampWhenProvided(t *testing.T) {
	c, ctx, _ := newAuditLogCtx()

	clientTS := "2025-02-14T09:30:00Z"
	err := c.WriteAuditEntry(ctx, "entry-1", "did:patientchain:p1", string(EventGrantIssued), "provider-1", "HospitalA", "grant-1 approved", clientTS, false)
	if err != nil {
		t.Fatalf("WriteAuditEntry returned error: %v", err)
	}

	entries, err := c.GetAuditTrailForPatient(ctx, "did:patientchain:p1")
	if err != nil {
		t.Fatalf("GetAuditTrailForPatient returned error: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	want, _ := time.Parse(time.RFC3339, clientTS)
	if got, _ := parseTS(entries[0].Timestamp); !got.Equal(want) {
		t.Errorf("expected timestamp %v, got %v", want, entries[0].Timestamp)
	}
	if entries[0].QueuedOffline {
		t.Error("expected QueuedOffline to be false")
	}
}

func TestWriteAuditEntryFallsBackToTxTimestampWhenClientTimestampEmpty(t *testing.T) {
	c, ctx, stub := newAuditLogCtx()

	if err := c.WriteAuditEntry(ctx, "entry-1", "did:patientchain:p1", string(EventGrantIssued), "provider-1", "HospitalA", "", "", false); err != nil {
		t.Fatalf("WriteAuditEntry returned error: %v", err)
	}

	entries, _ := c.GetAuditTrailForPatient(ctx, "did:patientchain:p1")
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if got, _ := parseTS(entries[0].Timestamp); !got.Equal(stub.txTime) {
		t.Errorf("expected fallback to tx timestamp %v, got %v", stub.txTime, entries[0].Timestamp)
	}
}

func TestWriteAuditEntryPreservesOriginalTimeWhenQueuedOffline(t *testing.T) {
	// The whole point of Section 3.6: the audit trail reflects the true
	// event timeline, not the connectivity timeline. An entry written
	// late (after reconnect) must still carry the moment it happened,
	// not the moment the write finally landed on the ledger.
	c, ctx, stub := newAuditLogCtx()

	eventTime := "2025-02-14T08:00:00Z"                           // when the action actually happened, offline
	stub.setTxTime(time.Date(2025, 2, 14, 9, 45, 0, 0, time.UTC)) // when the ledger write lands, after reconnect

	err := c.WriteAuditEntry(ctx, "entry-1", "did:patientchain:p1", string(EventGrantIssued), "provider-1", "HospitalA", "replayed from offline queue", eventTime, true)
	if err != nil {
		t.Fatalf("WriteAuditEntry returned error: %v", err)
	}

	entries, _ := c.GetAuditTrailForPatient(ctx, "did:patientchain:p1")
	want, _ := time.Parse(time.RFC3339, eventTime)
	if got, _ := parseTS(entries[0].Timestamp); !got.Equal(want) {
		t.Errorf("expected the original client-side event time %v to be preserved, got %v", want, entries[0].Timestamp)
	}
	if !entries[0].QueuedOffline {
		t.Error("expected QueuedOffline to be true")
	}
}

func TestWriteAuditEntryRejectsInvalidClientTimestamp(t *testing.T) {
	c, ctx, _ := newAuditLogCtx()
	err := c.WriteAuditEntry(ctx, "entry-1", "did:patientchain:p1", string(EventGrantIssued), "provider-1", "HospitalA", "", "not-a-timestamp", false)
	if err == nil {
		t.Fatal("expected an error for a malformed client timestamp, got nil")
	}
}

func TestWriteAuditEntryRejectsDuplicateEntryID(t *testing.T) {
	c, ctx, _ := newAuditLogCtx()
	if err := c.WriteAuditEntry(ctx, "entry-1", "did:patientchain:p1", string(EventGrantIssued), "provider-1", "HospitalA", "", "", false); err != nil {
		t.Fatalf("first WriteAuditEntry returned error: %v", err)
	}
	if err := c.WriteAuditEntry(ctx, "entry-1", "did:patientchain:p1", string(EventGrantRevoked), "provider-1", "HospitalA", "", "", false); err == nil {
		t.Fatal("expected an error reusing an existing entryID, got nil -- audit entries must be append-only")
	}
}

func TestGetAuditTrailForPatientOnlyReturnsThatPatients(t *testing.T) {
	c, ctx, _ := newAuditLogCtx()
	if err := c.WriteAuditEntry(ctx, "entry-1", "did:patientchain:p1", string(EventGrantIssued), "provider-1", "HospitalA", "", "", false); err != nil {
		t.Fatalf("WriteAuditEntry returned error: %v", err)
	}
	if err := c.WriteAuditEntry(ctx, "entry-2", "did:patientchain:p2", string(EventGrantIssued), "provider-2", "HospitalB", "", "", false); err != nil {
		t.Fatalf("WriteAuditEntry returned error: %v", err)
	}

	entries, err := c.GetAuditTrailForPatient(ctx, "did:patientchain:p1")
	if err != nil {
		t.Fatalf("GetAuditTrailForPatient returned error: %v", err)
	}
	if len(entries) != 1 || entries[0].EntryID != "entry-1" {
		t.Errorf("expected exactly entry-1 for p1, got %+v", entries)
	}
}

func TestVerifyImmutabilityDescribesNoMutationFunctions(t *testing.T) {
	c := &AuditLogContract{}
	msg := c.VerifyImmutability(nil)
	if msg == "" {
		t.Fatal("expected a non-empty immutability statement")
	}
}
