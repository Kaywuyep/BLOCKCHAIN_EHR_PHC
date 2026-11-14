package main

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
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
	DocType    string    `json:"docType"` // "grant"
	GrantID    string    `json:"grantID"`
	PatientDID string    `json:"patientDID"`
	ProviderID string    `json:"providerID"`
	HospitalID string    `json:"hospitalID"`
	GrantType  GrantType `json:"grantType"`
	Scope      []string  `json:"scope,omitempty" metadata:"scope,optional"`
	Purpose    string    `json:"purpose,omitempty" metadata:"purpose,optional"`
	// ProviderRole restricts the grant to one clinical role (e.g. "Physician",
	// "Laboratory Scientist"); the gateway refuses the record if the
	// requesting provider's registered role differs (Section 3.4.7).
	ProviderRole string `json:"providerRole,omitempty" metadata:"providerRole,optional"`
	// PatientSigned is true when the patient's own key signed the approval
	// (GrantAccess) and the signature was verified on-chain.
	PatientSigned bool `json:"patientSigned"`
	// RevokeSigned is the same for an early revocation.
	RevokeSigned   bool        `json:"revokeSigned"`
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
	// RequesterHospitalID is the hospital whose clinician may view the
	// records; HospitalID is the hospital that holds them. Cevruni only
	// mediates access BETWEEN facilities, so the two always differ: a
	// hospital's own staff read its own records in its own EMR.
	RequesterHospitalID string `json:"requesterHospitalID,omitempty" metadata:"requesterHospitalID,optional"`
	// RepresentativeHash: SHA-256 of the off-chain record of the family
	// member / representative who asked for emergency access (NHA 2014
	// s.26(2)(d)). Their details stay off-chain; the hash proves later that
	// the record was not altered.
	RepresentativeHash string `json:"representativeHash,omitempty" metadata:"representativeHash,optional"`
	// Extensions of a break-glass window, each with its reason.
	Extensions []Extension `json:"extensions,omitempty" metadata:"extensions,optional"`
}

// Extension is one extension of an emergency (break-glass) window.
type Extension struct {
	At        string `json:"at"`
	By        string `json:"by"`
	Minutes   int    `json:"minutes"`
	Reason    string `json:"reason"`
	ExpiresAt string `json:"expiresAt"`
}

// Emergency access policy (Section 3.4.7, NHA 2014 s.20 and s.26(2)(d),
// NDPA 2023 s.30(1)(c), GAID 2025 Art. 24): one hour, extendable with a
// reason up to 24 hours in total, limited to the record types needed in an
// emergency. Fixed here, on-chain, so no client can widen it.
const (
	breakGlassMinutes    = 60
	breakGlassMaxMinutes = 24 * 60
)

var emergencyScope = []string{"AllergyIntolerance", "MedicationRequest", "Condition", "Encounter", "Observation"}

// RequestAccess is called by a clinician's system asking to view a
// patient's records. It creates a PENDING grant that the patient must
// approve (Figure 3, step 3). scopeJSON is a JSON-encoded string array
// (e.g. `["Observation","MedicationRequest"]`) because Fabric chaincode
// arguments are plain strings; an empty array or "" means "no scope
// restriction recorded" and is left to the application layer to default.
func (c *AccessControlContract) RequestAccess(ctx contractapi.TransactionContextInterface, grantID string, patientDID string, providerID string, hospitalID string, scopeJSON string, purpose string, providerRole string, requesterHospitalID string) error {
	if requesterHospitalID == hospitalID {
		return fmt.Errorf("a hospital's own records are not shared through Cevruni; its staff use the hospital's own EMR")
	}
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
		DocType:             "grant",
		GrantID:             grantID,
		PatientDID:          patientDID,
		ProviderID:          providerID,
		HospitalID:          hospitalID,
		GrantType:           GrantTypeStandard,
		Scope:               scope,
		Purpose:             purpose,
		ProviderRole:        providerRole,
		RequesterHospitalID: requesterHospitalID,
		Status:              StatusPending,
		RequestedAt:         formatTS(txTimestamp.AsTime()),
	}

	if err := putGrant(ctx, grant); err != nil {
		return err
	}
	if err := indexGrant(ctx, grant); err != nil {
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
func (c *AccessControlContract) BreakGlassAccess(ctx contractapi.TransactionContextInterface, grantID string, patientDID string, providerID string, hospitalID string, requesterHospitalID string, justification string, representativeHash string) error {
	if justification == "" {
		return fmt.Errorf("a justification is required for break-glass access")
	}
	if requesterHospitalID == "" || requesterHospitalID == hospitalID {
		return fmt.Errorf("break-glass is for another hospital's records; a hospital's own records are in its own EMR")
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
	expires := now.Add(breakGlassMinutes * time.Minute)

	grant := AccessGrant{
		DocType:             "grant",
		GrantID:             grantID,
		PatientDID:          patientDID,
		ProviderID:          providerID,
		HospitalID:          hospitalID,
		GrantType:           GrantTypeBreakGlass,
		Scope:               append([]string(nil), emergencyScope...),
		Purpose:             "Emergency",
		Justification:       justification,
		RequesterHospitalID: requesterHospitalID,
		RepresentativeHash:  representativeHash,
		Status:              StatusActive,
		RequestedAt:         formatTS(now),
		GrantedAt:           formatTS(now),
		ExpiresAt:           formatTS(expires),
		ReviewRequired:      true,
	}

	if err := putGrant(ctx, grant); err != nil {
		return err
	}
	if err := indexGrant(ctx, grant); err != nil {
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

// ExtendBreakGlass extends an active emergency window by `minutes`, with a
// reason, never beyond 24 hours after it was opened. Only the clinician who
// invoked break-glass may extend it. Each extension is recorded on the grant
// and needs the (single) post-hoc review like the original.
func (c *AccessControlContract) ExtendBreakGlass(ctx contractapi.TransactionContextInterface, grantID string, providerID string, reason string, minutes int) error {
	grant, err := getGrant(ctx, grantID)
	if err != nil {
		return err
	}
	if grant.GrantType != GrantTypeBreakGlass {
		return fmt.Errorf("grant %s is not a break-glass grant", grantID)
	}
	if grant.ProviderID != providerID {
		return fmt.Errorf("only the clinician who opened emergency access can extend it")
	}
	if reason == "" {
		return fmt.Errorf("a reason is required to extend emergency access")
	}
	if minutes <= 0 || minutes > breakGlassMinutes {
		return fmt.Errorf("an extension is 1 to %d minutes", breakGlassMinutes)
	}
	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return err
	}
	now := txTimestamp.AsTime()
	expires, err := parseTS(grant.ExpiresAt)
	if err != nil {
		return err
	}
	if grant.Status != StatusActive || now.After(expires) {
		return fmt.Errorf("emergency access has ended; invoke break-glass again if still needed")
	}
	granted, err := parseTS(grant.GrantedAt)
	if err != nil {
		return err
	}
	limit := granted.Add(breakGlassMaxMinutes * time.Minute)
	newExpiry := expires.Add(time.Duration(minutes) * time.Minute)
	if newExpiry.After(limit) {
		if !expires.Before(limit) {
			return fmt.Errorf("emergency access has reached the 24-hour limit; the patient's own permission is needed now")
		}
		newExpiry = limit
	}
	grant.ExpiresAt = formatTS(newExpiry)
	grant.Extensions = append(grant.Extensions, Extension{At: formatTS(now), By: providerID, Minutes: minutes, Reason: reason, ExpiresAt: grant.ExpiresAt})
	if err := putGrant(ctx, *grant); err != nil {
		return err
	}
	return ctx.GetStub().SetEvent("BreakGlassExtended", mustMarshal(*grant))
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
// request, with a configurable time limit in minutes. signature is the
// patient's ECDSA P-256 signature (base64, raw r||s) over
// "grant:<grantID>:<durationMinutes>", verified against the public key the
// patient registered with their DID. Patients registered before key
// support (no SPKI key on record) may pass "".
func (c *AccessControlContract) GrantAccess(ctx contractapi.TransactionContextInterface, grantID string, durationMinutes int, signature string) error {
	grant, err := approveGrant(ctx, grantID, durationMinutes, signature)
	if err != nil {
		return err
	}
	if err := ctx.GetStub().SetEvent("AccessGranted", mustMarshal(*grant)); err != nil {
		return err
	}
	return bumpCostCounter(ctx, "grant")
}

// GrantBatchItem is one approval inside GrantAccessBatch.
type GrantBatchItem struct {
	GrantID         string `json:"grantID"`
	DurationMinutes int    `json:"durationMinutes"`
	Signature       string `json:"signature"`
}

// GrantAccessBatch approves several pending grants in ONE transaction --
// the batching technique of Section 3.4.4: grant actions that occur
// together (a patient approving several requests at once) share one
// endorsement, ordering and validation pass instead of paying for each.
// All-or-nothing: if any item fails, the whole transaction is rejected.
func (c *AccessControlContract) GrantAccessBatch(ctx contractapi.TransactionContextInterface, itemsJSON string) error {
	var items []GrantBatchItem
	if err := json.Unmarshal([]byte(itemsJSON), &items); err != nil {
		return fmt.Errorf("invalid batch JSON: %v", err)
	}
	if len(items) == 0 {
		return fmt.Errorf("batch is empty")
	}
	if len(items) > 50 {
		return fmt.Errorf("batch too large (max 50)")
	}
	seen := map[string]bool{}
	granted := make([]AccessGrant, 0, len(items))
	for _, it := range items {
		if seen[it.GrantID] {
			return fmt.Errorf("grant %s appears twice in the batch", it.GrantID)
		}
		seen[it.GrantID] = true
		grant, err := approveGrant(ctx, it.GrantID, it.DurationMinutes, it.Signature)
		if err != nil {
			return err
		}
		granted = append(granted, *grant)
	}
	if err := ctx.GetStub().SetEvent("AccessGrantedBatch", mustMarshal(granted)); err != nil {
		return err
	}
	return bumpCostCounter(ctx, "grant")
}

func approveGrant(ctx contractapi.TransactionContextInterface, grantID string, durationMinutes int, signature string) (*AccessGrant, error) {
	grant, err := getGrant(ctx, grantID)
	if err != nil {
		return nil, err
	}
	if grant.Status != StatusPending {
		return nil, fmt.Errorf("grant %s is not in PENDING state (current: %s)", grantID, grant.Status)
	}
	if durationMinutes <= 0 {
		return nil, fmt.Errorf("durationMinutes must be positive")
	}
	signed, err := verifyPatientSignature(ctx, grant.PatientDID, fmt.Sprintf("grant:%s:%d", grantID, durationMinutes), signature)
	if err != nil {
		return nil, err
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return nil, err
	}
	now := txTimestamp.AsTime()
	expires := now.Add(time.Duration(durationMinutes) * time.Minute)

	grant.Status = StatusActive
	grant.GrantedAt = formatTS(now)
	grant.ExpiresAt = formatTS(expires)
	grant.PatientSigned = signed

	if err := putGrant(ctx, *grant); err != nil {
		return nil, err
	}
	return grant, nil
}

// RevokeAccess lets the patient end a grant early, at any time.
// signature: the patient's signature over "revoke:<grantID>" (see GrantAccess).
func (c *AccessControlContract) RevokeAccess(ctx contractapi.TransactionContextInterface, grantID string, signature string) error {
	grant, err := getGrant(ctx, grantID)
	if err != nil {
		return err
	}
	// ACTIVE: revoke. PENDING: the patient declines the request.
	if grant.Status != StatusActive && grant.Status != StatusPending {
		return fmt.Errorf("grant %s is not ACTIVE or PENDING (current: %s)", grantID, grant.Status)
	}
	signed, err := verifyPatientSignature(ctx, grant.PatientDID, "revoke:"+grantID, signature)
	if err != nil {
		return err
	}
	grant.RevokeSigned = signed

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

// GetGrantsForHospital lists every grant covering one hospital's records,
// for that hospital's admin view. Composite-key index, LevelDB-friendly.
func (c *AccessControlContract) GetGrantsForHospital(ctx contractapi.TransactionContextInterface, hospitalID string) ([]*AccessGrant, error) {
	iterator, err := ctx.GetStub().GetStateByPartialCompositeKey("grant~hospital", []string{hospitalID})
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
		grant, err := getGrant(ctx, keyParts[1])
		if err != nil {
			return nil, err
		}
		grants = append(grants, grant)
	}
	return grants, nil
}

// GetGrantsByRequesterHospital lists grants whose viewing clinicians are at
// this hospital (its staff's access to other hospitals' records).
func (c *AccessControlContract) GetGrantsByRequesterHospital(ctx contractapi.TransactionContextInterface, hospitalID string) ([]*AccessGrant, error) {
	iterator, err := ctx.GetStub().GetStateByPartialCompositeKey("grant~requester", []string{hospitalID})
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
		grant, err := c.CheckAccess(ctx, keyParts[1])
		if err != nil {
			return nil, err
		}
		grants = append(grants, grant)
	}
	return grants, nil
}

// GetGrantsForProvider lists every grant naming one clinician, at any
// hospital, for the clinician's "View Records" page.
func (c *AccessControlContract) GetGrantsForProvider(ctx contractapi.TransactionContextInterface, providerID string) ([]*AccessGrant, error) {
	iterator, err := ctx.GetStub().GetStateByPartialCompositeKey("grant~provider", []string{providerID})
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
		grant, err := c.CheckAccess(ctx, keyParts[1])
		if err != nil {
			return nil, err
		}
		grants = append(grants, grant)
	}
	return grants, nil
}

func indexGrant(ctx contractapi.TransactionContextInterface, grant AccessGrant) error {
	for _, idx := range [][]string{{"grant~patient", grant.PatientDID}, {"grant~hospital", grant.HospitalID}, {"grant~provider", grant.ProviderID}, {"grant~requester", grant.RequesterHospitalID}} {
		if idx[1] == "" {
			continue
		}
		key, err := ctx.GetStub().CreateCompositeKey(idx[0], []string{idx[1], grant.GrantID})
		if err != nil {
			return err
		}
		if err := ctx.GetStub().PutState(key, []byte{0x00}); err != nil {
			return err
		}
	}
	return nil
}

// verifyPatientSignature checks a patient's ECDSA P-256 signature (base64,
// raw r||s as produced by WebCrypto) over message, using the SPKI public
// key (base64 DER) the patient registered with their DID. Returns true
// when a signature was verified. A patient whose registered key is not an
// SPKI key (registered before key support) may omit the signature; a
// patient WITH a key must always sign.
func verifyPatientSignature(ctx contractapi.TransactionContextInterface, patientDID string, message string, signature string) (bool, error) {
	data, err := ctx.GetStub().GetState(patientKey(patientDID))
	if err != nil {
		return false, err
	}
	if data == nil {
		// No DID record on this ledger (e.g. registered before key
		// support): nothing to verify against.
		return false, nil
	}
	var patient Patient
	if err := json.Unmarshal(data, &patient); err != nil {
		return false, err
	}
	der, derErr := base64.StdEncoding.DecodeString(patient.PublicKey)
	var pub *ecdsa.PublicKey
	if derErr == nil {
		if parsed, err := x509.ParsePKIXPublicKey(der); err == nil {
			pub, _ = parsed.(*ecdsa.PublicKey)
		}
	}
	if pub == nil {
		// Legacy patient without a verifiable key.
		return false, nil
	}
	if signature == "" {
		return false, fmt.Errorf("this action must be signed with the patient's key")
	}
	sig, err := base64.StdEncoding.DecodeString(signature)
	if err != nil || len(sig) != 64 {
		return false, fmt.Errorf("malformed patient signature")
	}
	hash := sha256.Sum256([]byte(message))
	r := new(big.Int).SetBytes(sig[:32])
	sVal := new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(pub, hash[:], r, sVal) {
		return false, fmt.Errorf("patient signature does not verify")
	}
	return true, nil
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
