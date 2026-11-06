package main

import (
	"testing"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

func newPatientRegistryCtx() (*PatientRegistryContract, *contractapi.TransactionContext, *fakeStub) {
	stub := newFakeStub()
	ctx := &contractapi.TransactionContext{}
	ctx.SetStub(stub)
	ctx.SetClientIdentity(&fakeClientIdentity{id: "x509::CN=clinician-1"})
	return &PatientRegistryContract{}, ctx, stub
}

func TestRegisterPatient(t *testing.T) {
	c, ctx, _ := newPatientRegistryCtx()

	if err := c.RegisterPatient(ctx, "did:patientchain:p1", "pubkey-abc"); err != nil {
		t.Fatalf("RegisterPatient returned error: %v", err)
	}

	patient, err := c.GetPatient(ctx, "did:patientchain:p1")
	if err != nil {
		t.Fatalf("GetPatient returned error: %v", err)
	}
	if patient.PatientDID != "did:patientchain:p1" {
		t.Errorf("expected patientDID did:patientchain:p1, got %s", patient.PatientDID)
	}
	if patient.PublicKey != "pubkey-abc" {
		t.Errorf("expected publicKey pubkey-abc, got %s", patient.PublicKey)
	}
}

func TestRegisterPatientRejectsEmptyDID(t *testing.T) {
	c, ctx, _ := newPatientRegistryCtx()

	if err := c.RegisterPatient(ctx, "", "pubkey-abc"); err == nil {
		t.Fatal("expected an error registering a patient with an empty DID, got nil")
	}
}

func TestRegisterPatientRejectsDuplicate(t *testing.T) {
	c, ctx, _ := newPatientRegistryCtx()

	if err := c.RegisterPatient(ctx, "did:patientchain:p1", "pubkey-abc"); err != nil {
		t.Fatalf("first RegisterPatient returned error: %v", err)
	}
	if err := c.RegisterPatient(ctx, "did:patientchain:p1", "pubkey-def"); err == nil {
		t.Fatal("expected an error re-registering an existing DID, got nil")
	}
}

func TestGetPatientNotFound(t *testing.T) {
	c, ctx, _ := newPatientRegistryCtx()

	if _, err := c.GetPatient(ctx, "did:patientchain:missing"); err == nil {
		t.Fatal("expected an error for an unregistered patient, got nil")
	}
}

func TestRegisterRecordReferenceRequiresRegisteredPatient(t *testing.T) {
	c, ctx, _ := newPatientRegistryCtx()

	err := c.RegisterRecordReference(ctx, "ref-1", "did:patientchain:unregistered", "HospitalA", "encounter", time.Now().Format(time.RFC3339))
	if err == nil {
		t.Fatal("expected an error registering a reference for an unregistered patient, got nil")
	}
}

func TestRegisterRecordReferenceNeverStoresClinicalPayload(t *testing.T) {
	// This is the structural guarantee Section 3.7 depends on: the only
	// fields ever accepted are hospitalID/recordType/date -- there is no
	// parameter through which a clinical payload could enter the ledger.
	c, ctx, stub := newPatientRegistryCtx()

	if err := c.RegisterPatient(ctx, "did:patientchain:p1", "pubkey-abc"); err != nil {
		t.Fatalf("RegisterPatient returned error: %v", err)
	}

	dateStr := "2025-03-04T10:00:00Z"
	if err := c.RegisterRecordReference(ctx, "ref-1", "did:patientchain:p1", "HospitalA", "lab", dateStr); err != nil {
		t.Fatalf("RegisterRecordReference returned error: %v", err)
	}

	refs, err := c.GetRecordReferencesForPatient(ctx, "did:patientchain:p1")
	if err != nil {
		t.Fatalf("GetRecordReferencesForPatient returned error: %v", err)
	}
	if len(refs) != 1 {
		t.Fatalf("expected 1 reference, got %d", len(refs))
	}
	ref := refs[0]
	if ref.RecordType != "lab" || ref.HospitalID != "HospitalA" {
		t.Errorf("unexpected reference contents: %+v", ref)
	}
	if ref.RegisteredBy != "x509::CN=clinician-1" {
		t.Errorf("expected RegisteredBy to be the caller identity, got %s", ref.RegisteredBy)
	}
	wantDate, _ := time.Parse(time.RFC3339, dateStr)
	if gotDate, _ := parseTS(ref.Date); !gotDate.Equal(wantDate) {
		t.Errorf("expected date %v, got %v", wantDate, ref.Date)
	}

	// Every key actually written to the ledger for this call must decode
	// to something in {Patient, RecordReference, composite-key index,
	// cost counter} -- never a raw clinical field like "diagnosis" or a
	// FHIR resource body.
	for key := range stub.state {
		switch {
		case key == patientKey("did:patientchain:p1"):
		case key == refKey("ref-1"):
		default:
			// Anything else should only be a composite key: the
			// ref~patient index or a costevent marker.
			if len(key) == 0 || key[0] != 0x00 {
				t.Errorf("unexpected ledger key written: %q", key)
			}
		}
	}
}

func TestRegisterRecordReferenceRejectsInvalidDate(t *testing.T) {
	c, ctx, _ := newPatientRegistryCtx()
	if err := c.RegisterPatient(ctx, "did:patientchain:p1", "pubkey-abc"); err != nil {
		t.Fatalf("RegisterPatient returned error: %v", err)
	}

	if err := c.RegisterRecordReference(ctx, "ref-1", "did:patientchain:p1", "HospitalA", "lab", "not-a-date"); err == nil {
		t.Fatal("expected an error for a non-RFC3339 date, got nil")
	}
}

func TestRegisterRecordReferenceRejectsDuplicateRefID(t *testing.T) {
	c, ctx, _ := newPatientRegistryCtx()
	if err := c.RegisterPatient(ctx, "did:patientchain:p1", "pubkey-abc"); err != nil {
		t.Fatalf("RegisterPatient returned error: %v", err)
	}
	dateStr := time.Now().Format(time.RFC3339)
	if err := c.RegisterRecordReference(ctx, "ref-1", "did:patientchain:p1", "HospitalA", "lab", dateStr); err != nil {
		t.Fatalf("first RegisterRecordReference returned error: %v", err)
	}
	if err := c.RegisterRecordReference(ctx, "ref-1", "did:patientchain:p1", "HospitalA", "lab", dateStr); err == nil {
		t.Fatal("expected an error re-registering the same refID, got nil")
	}
}

func TestGetRecordReferencesForPatientOnlyReturnsThatPatients(t *testing.T) {
	c, ctx, _ := newPatientRegistryCtx()
	for _, did := range []string{"did:patientchain:p1", "did:patientchain:p2"} {
		if err := c.RegisterPatient(ctx, did, "pubkey"); err != nil {
			t.Fatalf("RegisterPatient(%s) returned error: %v", did, err)
		}
	}
	dateStr := time.Now().Format(time.RFC3339)
	if err := c.RegisterRecordReference(ctx, "ref-p1-a", "did:patientchain:p1", "HospitalA", "lab", dateStr); err != nil {
		t.Fatalf("RegisterRecordReference returned error: %v", err)
	}
	if err := c.RegisterRecordReference(ctx, "ref-p2-a", "did:patientchain:p2", "HospitalB", "imaging", dateStr); err != nil {
		t.Fatalf("RegisterRecordReference returned error: %v", err)
	}

	refs, err := c.GetRecordReferencesForPatient(ctx, "did:patientchain:p1")
	if err != nil {
		t.Fatalf("GetRecordReferencesForPatient returned error: %v", err)
	}
	if len(refs) != 1 || refs[0].RefID != "ref-p1-a" {
		t.Errorf("expected exactly ref-p1-a for p1, got %+v", refs)
	}
}
