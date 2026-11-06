package main

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// AccessControlContract manages provider permission grants and revocations
// (Section 3.5). Grants are time-bounded and auto-expire; the patient may
// revoke early at any time.
type AccessControlContract struct {
	contractapi.Contract
}

type GrantStatus string

const (
	StatusPending GrantStatus = "PENDING"
	StatusActive  GrantStatus = "ACTIVE"
	StatusRevoked GrantStatus = "REVOKED"
	StatusExpired GrantStatus = "EXPIRED"
)

// GrantType distinguishes a normal, patient-approved grant from an
// emergency override (Section 35.1's "break-glass" access), which is
// active immediately but always requires a post-hoc review.
type GrantType string

const (
	GrantTypeStandard   GrantType = "STANDARD"
	GrantTypeBreakGlass GrantType = "BREAK_GLASS"
)

// AccessGrant records one provider's permission to query one patient's
// record references at one hospital, for a bounded time window. Scope and
// Purpose implement docs/design.md Section 8 (FHIR-resource-scoped
// authorization) and Section 35.1 (purpose-of-use limitation) -- neither
// is enforced inside this contract (Fabric has no concept of "the record
// that's being requested right now"); the FHIR gateway/backend checks the
// requested resource types and purpose against these fields before
// releasing any record, per Section 29 ("never trust the frontend").
type AccessGrant struct {
	DocType        string      `json:"docType"` // "grant"
	GrantID        string      `json:"grantID"`
	PatientDID     string      `json:"patientDID"`
	ProviderID     string      `json:"providerID"`
	HospitalID     string      `json:"hospitalID"`
	GrantType      GrantType   `json:"grantType"`
	Scope          []string    `json:"scope,omitempty" metadata:"scope,optional"`
	Purpose        string      `json:"purpose,omitempty" metadata:"purpose,optional"`
	Justification  string      `json:"justification,omitempty" metadata:"justification,optional"` // break-glass only
	Status         GrantStatus `json:"status"`
	RequestedAt    string      `json:"requestedAt"`
	GrantedAt      string      `json:"grantedAt,omitempty" metadata:"grantedAt,optional"`
	ExpiresAt      string      `json:"expiresAt,omitempty" metadata:"expiresAt,optional"`
	RevokedAt      string      `json:"revokedAt,omitempty" metadata:"revokedAt,optional"`
	ReviewRequired bool        `json:"reviewRequired"`
	Reviewed       bool        `json:"reviewed"`
	ReviewedAt     string      `json:"reviewedAt,omitempty" metadata:"reviewedAt,optional"`
	ReviewedBy     string      `json:"reviewedBy,omitempty" metadata:"reviewedBy,optional"`
	ReviewNotes    string      `json:"reviewNotes,omitempty" metadata:"reviewNotes,optional"`
}

// RequestAccess is called by a clinician's system asking to view a
// patient's records. It creates a PENDING grant that the patient must
// approve (Figure 3, step 3). scopeJSON is a JSON-encoded string array
// (e.g. `["Observation","MedicationRequest"]`) because Fabric chaincode
// arguments are plain strings; an empty array or "" means "no scope
// restriction recorded" and is left to the application layer to default.
func (c *AccessControlContract) RequestAccess(ctx contractapi.TransactionContextInterface, grantID string, patientDID string, providerID string, hospitalID string, scopeJSON string, purpose string) error {
	existing, err := ctx.GetStub().GetState(grantKey(grantID))
	if err != nil {
		return err
	}
	if existing != nil {
		return fmt.Errorf("grant %s already exists", grantID)
	}

	var scope []string
	if scopeJSON != "" {
		if err := json.Unmarshal([]byte(scopeJSON), &scope); err != nil {
			return fmt.Errorf("invalid scope JSON: %v", err)
		}
	}
	if purpose == "" {
		purpose = "Treatment"
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return err
	}

	grant := AccessGrant{
		DocType:     "grant",
		GrantID:     grantID,
		PatientDID:  patientDID,
		ProviderID:  providerID,
		HospitalID:  hospitalID,
		GrantType:   GrantTypeStandard,
		Scope:       scope,
		Purpose:     purpose,
		Status:      StatusPending,
		RequestedAt: formatTS(txTimestamp.AsTime()),
	}

	if err := putGrant(ctx, grant); err != nil {
		return err
	}

	compositeKey, err := ctx.GetStub().CreateCompositeKey("grant~patient", []string{patientDID, grantID})
	if err != nil {
		return err
	}
	if err := ctx.GetStub().PutState(compositeKey, []byte{0x00}); err != nil {
		return err
	}

	if err := ctx.GetStub().SetEvent("AccessRequested", mustMarshal(grant)); err != nil {
		return err
	}

	return bumpCostCounter(ctx, "grant")
}

// BreakGlassAccess implements the emergency-override policy from Section
// 35.1: it creates an ACTIVE grant immediately, with no patient-approval
// step, but flags it distinctly (GrantType BREAK_GLASS) and marks it as
// requiring a mandatory post-hoc review. justification is required and is
// stored on the grant so both the patient and the hospital can see why
// this override was used.
func (c *AccessControlContract) BreakGlassAccess(ctx contractapi.TransactionContextInterface, grantID string, patientDID string, providerID string, hospitalID string, justification string) error {
	if justification == "" {
		return fmt.Errorf("a justification is required for break-glass access")
	}
	existing, err := ctx.GetStub().GetState(grantKey(grantID))
	if err != nil {
		return err
	}
	if existing != nil {
		return fmt.Errorf("grant %s already exists", grantID)
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return err
	}
	now := txTimestamp.AsTime()
	expires := now.Add(15 * time.Minute) // short default window, per Section 35.1

	grant := AccessGrant{
		DocType:        "grant",
		GrantID:        grantID,
		PatientDID:     patientDID,
		ProviderID:     providerID,
		HospitalID:     hospitalID,
		GrantType:      GrantTypeBreakGlass,
		Purpose:        "Emergency",
		Justification:  justification,
		Status:         StatusActive,
		RequestedAt:    formatTS(now),
		GrantedAt:      formatTS(now),
		ExpiresAt:      formatTS(expires),
		ReviewRequired: true,
	}

	if err := putGrant(ctx, grant); err != nil {
		return err
	}

	compositeKey, err := ctx.GetStub().CreateCompositeKey("grant~patient", []string{patientDID, grantID})
	if err != nil {
		return err
	}
	if err := ctx.GetStub().PutState(compositeKey, []byte{0x00}); err != nil {
		return err
	}

	pendingKey, err := ctx.GetStub().CreateCompositeKey("breakglass~pending", []string{grantID})
	if err != nil {
		return err
	}
	if err := ctx.GetStub().PutState(pendingKey, []byte{0x00}); err != nil {
		return err
	}

	if err := ctx.GetStub().SetEvent("BreakGlassAccess", mustMarshal(grant)); err != nil {
		return err
	}

	if err := bumpCostCounter(ctx, "breakglass"); err != nil {
		return err
	}
	return bumpCostCounter(ctx, "grant")
}

// ReviewBreakGlass closes the mandatory post-hoc review loop. It never
// changes what the provider already saw -- only records that a hospital
// administrator (or the patient) has since reviewed why the override was
// used.
func (c *AccessControlContract) ReviewBreakGlass(ctx contractapi.TransactionContextInterface, grantID string, reviewerID string, notes string) error {
	grant, err := getGrant(ctx, grantID)
	if err != nil {
		return err
	}
	if grant.GrantType != GrantTypeBreakGlass {
		return fmt.Errorf("grant %s is not a break-glass grant", grantID)
	}
	if grant.Reviewed {
		return fmt.Errorf("grant %s has already been reviewed", grantID)
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return err
	}
	now := txTimestamp.AsTime()

	grant.Reviewed = true
	grant.ReviewedAt = formatTS(now)
	grant.ReviewedBy = reviewerID
	grant.ReviewNotes = notes

	if err := putGrant(ctx, *grant); err != nil {
		return err
	}

	pendingKey, err := ctx.GetStub().CreateCompositeKey("breakglass~pending", []string{grantID})
	if err != nil {
		return err
	}
	if err := ctx.GetStub().DelState(pendingKey); err != nil {
		return err
	}

	return ctx.GetStub().SetEvent("BreakGlassReviewed", mustMarshal(*grant))
}

// GetPendingBreakGlassReviews lists every break-glass grant that has not
// yet been reviewed, for the hospital admin dashboard's review queue.
// Uses a dedicated composite-key index (not partitioned by patient) so
// this cross-patient query still works against plain LevelDB, per Section
// 3.9 -- no CouchDB rich query required.
func (c *AccessControlContract) GetPendingBreakGlassReviews(ctx contractapi.TransactionContextInterface) ([]*AccessGrant, error) {
	iterator, err := ctx.GetStub().GetStateByPartialCompositeKey("breakglass~pending", []string{})
	if err != nil {
		return nil, err
	}
	defer iterator.Close()

	var grants []*AccessGrant
	for iterator.HasNext() {
		kv, err := iterator.Next()
		if err != nil {
			return nil, err
		}
		_, keyParts, err := ctx.GetStub().SplitCompositeKey(kv.Key)
		if err != nil {
			return nil, err
		}
		grant, err := getGrant(ctx, keyParts[0])
		if err != nil {
			return nil, err
		}
		grants = append(grants, grant)
	}
	return grants, nil
}

// GrantAccess is the patient's signed transaction approving a pending
// request, with a configurable time limit in minutes.
func (c *AccessControlContract) GrantAccess(ctx contractapi.TransactionContextInterface, grantID string, durationMinutes int) error {
	grant, err := getGrant(ctx, grantID)
	if err != nil {
		return err
	}
	if grant.Status != StatusPending {
		return fmt.Errorf("grant %s is not in PENDING state (current: %s)", grantID, grant.Status)
	}
	if durationMinutes <= 0 {
		return fmt.Errorf("durationMinutes must be positive")
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return err
	}
	now := txTimestamp.AsTime()
	expires := now.Add(time.Duration(durationMinutes) * time.Minute)

	grant.Status = StatusActive
	grant.GrantedAt = formatTS(now)
	grant.ExpiresAt = formatTS(expires)

	if err := putGrant(ctx, *grant); err != nil {
		return err
	}

	if err := ctx.GetStub().SetEvent("AccessGranted", mustMarshal(*grant)); err != nil {
		return err
	}

	return bumpCostCounter(ctx, "grant")
}

// RevokeAccess lets the patient end a grant early, at any time.
func (c *AccessControlContract) RevokeAccess(ctx contractapi.TransactionContextInterface, grantID string) error {
	grant, err := getGrant(ctx, grantID)
	if err != nil {
		return err
	}
	if grant.Status != StatusActive {
		return fmt.Errorf("grant %s is not ACTIVE (current: %s)", grantID, grant.Status)
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return err
	}
	now := txTimestamp.AsTime()

	grant.Status = StatusRevoked
	grant.RevokedAt = formatTS(now)

	if err := putGrant(ctx, *grant); err != nil {
		return err
	}

	if err := ctx.GetStub().SetEvent("AccessRevoked", mustMarshal(*grant)); err != nil {
		return err
	}

	return bumpCostCounter(ctx, "grant")
}

// CheckAccess is a read-only query the FHIR Adapter calls before pulling
// any record from a hospital database (Figure 4, step 1). It also
// lazily resolves EXPIRED status rather than requiring a separate cron
// transaction, since Fabric has no native scheduler.
func (c *AccessControlContract) CheckAccess(ctx contractapi.TransactionContextInterface, grantID string) (*AccessGrant, error) {
	grant, err := getGrant(ctx, grantID)
	if err != nil {
		return nil, err
	}
	if grant.Status == StatusActive && grant.ExpiresAt != "" {
		txTimestamp, err := ctx.GetStub().GetTxTimestamp()
		if err != nil {
			return nil, err
		}
		expiresAt, err := parseTS(grant.ExpiresAt)
		if err != nil {
			return nil, fmt.Errorf("grant %s has a malformed expiry: %v", grantID, err)
		}
		if txTimestamp.AsTime().After(expiresAt) {
			grant.Status = StatusExpired
			// Persist the lazily-resolved expiry so subsequent reads are consistent.
			_ = putGrant(ctx, *grant)
		}
	}
	return grant, nil
}

// GetGrantsForPatient lists every grant (any status) a patient has issued,
// for display in the patient app's "who can see my records" view. Uses a
// composite-key index rather than a rich query, so it works against the
// plain LevelDB state database specified in Section 3.9 — no CouchDB
// dependency required for the MVP.
func (c *AccessControlContract) GetGrantsForPatient(ctx contractapi.TransactionContextInterface, patientDID string) ([]*AccessGrant, error) {
	iterator, err := ctx.GetStub().GetStateByPartialCompositeKey("grant~patient", []string{patientDID})
	if err != nil {
		return nil, err
	}
	defer iterator.Close()

	var grants []*AccessGrant
	for iterator.HasNext() {
		kv, err := iterator.Next()
		if err != nil {
			return nil, err
		}
		_, keyParts, err := ctx.GetStub().SplitCompositeKey(kv.Key)
		if err != nil {
			return nil, err
		}
		grantID := keyParts[1]
		grant, err := getGrant(ctx, grantID)
		if err != nil {
			return nil, err
		}
		grants = append(grants, grant)
	}
	return grants, nil
}

func getGrant(ctx contractapi.TransactionContextInterface, grantID string) (*AccessGrant, error) {
	data, err := ctx.GetStub().GetState(grantKey(grantID))
	if err != nil {
		return nil, fmt.Errorf("failed to read world state: %v", err)
	}
	if data == nil {
		return nil, fmt.Errorf("grant %s not found", grantID)
	}
	var grant AccessGrant
	if err := json.Unmarshal(data, &grant); err != nil {
		return nil, err
	}
	return &grant, nil
}

func putGrant(ctx contractapi.TransactionContextInterface, grant AccessGrant) error {
	return ctx.GetStub().PutState(grantKey(grant.GrantID), mustMarshal(grant))
}

func grantKey(grantID string) string {
	return "GRANT_" + grantID
}

func mustMarshal(v interface{}) []byte {
	b, _ := json.Marshal(v)
	return b
}
