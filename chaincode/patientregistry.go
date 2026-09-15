package main

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// PatientRegistryContract manages patient DIDs and on-chain record-reference
// pointers. It never stores clinical content — only HospitalID, RecordType
// and Date, per Section 3.7 of the design.
type PatientRegistryContract struct {
	contractapi.Contract
}

// Patient represents a registered patient DID. No demographic or clinical
// data is stored here — the DID is the sole identifier on-chain.
type Patient struct {
	DocType      string    `json:"docType"` // "patient"
	PatientDID   string    `json:"patientDID"`
	PublicKey    string    `json:"publicKey"` // DID public key material
	RegisteredAt time.Time `json:"registeredAt"`
}

// RecordReference is the only artifact ever written on-chain about a
// clinical record: a pointer, never the record itself.
type RecordReference struct {
	DocType      string    `json:"docType"` // "recordref"
	RefID        string    `json:"refID"`
	PatientDID   string    `json:"patientDID"`
	HospitalID   string    `json:"hospitalID"`
	RecordType   string    `json:"recordType"` // e.g. "encounter", "lab", "imaging"
	Date         time.Time `json:"date"`
	RegisteredBy string    `json:"registeredBy"` // hospital's reference-service identity
}

// RegisterPatient creates a new patient DID entry on-chain. Idempotent:
// re-registering the same DID is rejected to protect identity integrity.
func (c *PatientRegistryContract) RegisterPatient(ctx contractapi.TransactionContextInterface, patientDID string, publicKey string) error {
	if patientDID == "" {
		return fmt.Errorf("patientDID must not be empty")
	}
	existing, err := ctx.GetStub().GetState(patientKey(patientDID))
	if err != nil {
		return fmt.Errorf("failed to read world state: %v", err)
	}
	if existing != nil {
		return fmt.Errorf("patient %s is already registered", patientDID)
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("failed to get tx timestamp: %v", err)
	}

	patient := Patient{
		DocType:      "patient",
		PatientDID:   patientDID,
		PublicKey:    publicKey,
		RegisteredAt: txTimestamp.AsTime(),
	}

	patientJSON, err := json.Marshal(patient)
	if err != nil {
		return err
	}

	if err := ctx.GetStub().PutState(patientKey(patientDID), patientJSON); err != nil {
		return err
	}

	return bumpCostCounter(ctx, "registration")
}

// GetPatient retrieves a registered patient's DID record.
func (c *PatientRegistryContract) GetPatient(ctx contractapi.TransactionContextInterface, patientDID string) (*Patient, error) {
	data, err := ctx.GetStub().GetState(patientKey(patientDID))
	if err != nil {
		return nil, fmt.Errorf("failed to read world state: %v", err)
	}
	if data == nil {
		return nil, fmt.Errorf("patient %s not found", patientDID)
	}
	var patient Patient
	if err := json.Unmarshal(data, &patient); err != nil {
		return nil, err
	}
	return &patient, nil
}

// RegisterRecordReference is called by a hospital's Reference & Query
// Service each time a new clinical record is created locally (Figure 3,
// step 2). Only metadata is written on-chain — sP in the cost model
// (Section 3.5.2), never the FHIR payload sR.
func (c *PatientRegistryContract) RegisterRecordReference(ctx contractapi.TransactionContextInterface, refID string, patientDID string, hospitalID string, recordType string, dateRFC3339 string) error {
	// Confirm the patient DID exists before accepting a reference for it.
	patientData, err := ctx.GetStub().GetState(patientKey(patientDID))
	if err != nil {
		return fmt.Errorf("failed to read world state: %v", err)
	}
	if patientData == nil {
		return fmt.Errorf("patient %s is not registered", patientDID)
	}

	existing, err := ctx.GetStub().GetState(refKey(refID))
	if err != nil {
		return err
	}
	if existing != nil {
		return fmt.Errorf("record reference %s already exists", refID)
	}

	date, err := time.Parse(time.RFC3339, dateRFC3339)
	if err != nil {
		return fmt.Errorf("invalid date format, expected RFC3339: %v", err)
	}

	callerID, err := ctx.GetClientIdentity().GetID()
	if err != nil {
		return err
	}

	ref := RecordReference{
		DocType:      "recordref",
		RefID:        refID,
		PatientDID:   patientDID,
		HospitalID:   hospitalID,
		RecordType:   recordType,
		Date:         date,
		RegisteredBy: callerID,
	}

	refJSON, err := json.Marshal(ref)
	if err != nil {
		return err
	}

	if err := ctx.GetStub().PutState(refKey(refID), refJSON); err != nil {
		return err
	}

	// Composite key index so a patient's references can be range-queried
	// without a full-ledger scan.
	compositeKey, err := ctx.GetStub().CreateCompositeKey("ref~patient", []string{patientDID, refID})
	if err != nil {
		return err
	}
	if err := ctx.GetStub().PutState(compositeKey, []byte{0x00}); err != nil {
		return err
	}

	// Event-driven notification (Section 3.5, "event-driven execution")
	// instead of requiring clients to poll.
	if err := ctx.GetStub().SetEvent("RecordReferenceRegistered", refJSON); err != nil {
		return err
	}

	return bumpCostCounter(ctx, "reference")
}

// GetRecordReferencesForPatient returns every reference pointer registered
// for a patient, across every participating hospital.
func (c *PatientRegistryContract) GetRecordReferencesForPatient(ctx contractapi.TransactionContextInterface, patientDID string) ([]*RecordReference, error) {
	iterator, err := ctx.GetStub().GetStateByPartialCompositeKey("ref~patient", []string{patientDID})
	if err != nil {
		return nil, err
	}
	defer iterator.Close()

	var refs []*RecordReference
	for iterator.HasNext() {
		kv, err := iterator.Next()
		if err != nil {
			return nil, err
		}
		_, keyParts, err := ctx.GetStub().SplitCompositeKey(kv.Key)
		if err != nil {
			return nil, err
		}
		refID := keyParts[1]
		refData, err := ctx.GetStub().GetState(refKey(refID))
		if err != nil {
			return nil, err
		}
		var ref RecordReference
		if err := json.Unmarshal(refData, &ref); err != nil {
			return nil, err
		}
		refs = append(refs, &ref)
	}
	return refs, nil
}

func patientKey(patientDID string) string {
	return "PATIENT_" + patientDID
}

func refKey(refID string) string {
	return "REF_" + refID
}
