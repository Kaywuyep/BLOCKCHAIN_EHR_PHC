package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"testing"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

func newAccessControlCtx() (*AccessControlContract, *contractapi.TransactionContext, *fakeStub) {
	stub := newFakeStub()
	ctx := &contractapi.TransactionContext{}
	ctx.SetStub(stub)
	return &AccessControlContract{}, ctx, stub
}

func TestRequestAccessCreatesPendingGrant(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()

	err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", `["Observation","MedicationRequest"]`, "Treatment", "", "HospitalZ")
	if err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}

	grant, err := c.CheckAccess(ctx, "grant-1")
	if err != nil {
		t.Fatalf("CheckAccess returned error: %v", err)
	}
	if grant.Status != StatusPending {
		t.Errorf("expected status PENDING, got %s", grant.Status)
	}
	if grant.GrantType != GrantTypeStandard {
		t.Errorf("expected grant type STANDARD, got %s", grant.GrantType)
	}
	if len(grant.Scope) != 2 || grant.Scope[0] != "Observation" {
		t.Errorf("unexpected scope: %v", grant.Scope)
	}
}

func TestRequestAccessDefaultsPurposeToTreatment(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", "", "", "HospitalZ"); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	grant, _ := c.CheckAccess(ctx, "grant-1")
	if grant.Purpose != "Treatment" {
		t.Errorf("expected default purpose Treatment, got %s", grant.Purpose)
	}
}

func TestRequestAccessRejectsDuplicateGrantID(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", "", "", "HospitalZ"); err != nil {
		t.Fatalf("first RequestAccess returned error: %v", err)
	}
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-2", "HospitalB", "", "", "", "HospitalZ"); err == nil {
		t.Fatal("expected an error reusing an existing grantID, got nil")
	}
}

func TestRequestAccessRejectsInvalidScopeJSON(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "not-json", "", "", "HospitalZ"); err == nil {
		t.Fatal("expected an error for malformed scope JSON, got nil")
	}
}

func TestGrantAccessActivatesPendingGrant(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", "", "", "HospitalZ"); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}

	if err := c.GrantAccess(ctx, "grant-1", 30, ""); err != nil {
		t.Fatalf("GrantAccess returned error: %v", err)
	}

	grant, err := c.CheckAccess(ctx, "grant-1")
	if err != nil {
		t.Fatalf("CheckAccess returned error: %v", err)
	}
	if grant.Status != StatusActive {
		t.Errorf("expected status ACTIVE, got %s", grant.Status)
	}
	if grant.ExpiresAt == "" {
		t.Fatal("expected ExpiresAt to be set")
	}
	wantExpiry := ctx.GetStub().(*fakeStub).txTime.Add(30 * time.Minute)
	if gotExpiry, err := parseTS(grant.ExpiresAt); err != nil || !gotExpiry.Equal(wantExpiry) {
		t.Errorf("expected expiry %v, got %v", wantExpiry, grant.ExpiresAt)
	}
}

func TestGrantAccessRejectsNonPendingGrant(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", "", "", "HospitalZ"); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	if err := c.GrantAccess(ctx, "grant-1", 30, ""); err != nil {
		t.Fatalf("first GrantAccess returned error: %v", err)
	}
	if err := c.GrantAccess(ctx, "grant-1", 30, ""); err == nil {
		t.Fatal("expected an error granting an already-ACTIVE grant, got nil")
	}
}

func TestGrantAccessRejectsNonPositiveDuration(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", "", "", "HospitalZ"); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	if err := c.GrantAccess(ctx, "grant-1", 0, ""); err == nil {
		t.Fatal("expected an error for a zero duration, got nil")
	}
}

func TestRevokeAccessEndsActiveGrant(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", "", "", "HospitalZ"); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	if err := c.GrantAccess(ctx, "grant-1", 30, ""); err != nil {
		t.Fatalf("GrantAccess returned error: %v", err)
	}
	if err := c.RevokeAccess(ctx, "grant-1", ""); err != nil {
		t.Fatalf("RevokeAccess returned error: %v", err)
	}

	grant, err := c.CheckAccess(ctx, "grant-1")
	if err != nil {
		t.Fatalf("CheckAccess returned error: %v", err)
	}
	if grant.Status != StatusRevoked {
		t.Errorf("expected status REVOKED, got %s", grant.Status)
	}
	if grant.RevokedAt == "" {
		t.Error("expected RevokedAt to be set")
	}
}

func TestRevokeAccessRejectsNonActiveGrant(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", "", "", "HospitalZ"); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	// PENDING may be declined once; an already revoked grant cannot be revoked again.
	if err := c.RevokeAccess(ctx, "grant-1", ""); err != nil {
		t.Fatalf("declining a PENDING request failed: %v", err)
	}
	if err := c.RevokeAccess(ctx, "grant-1", ""); err == nil {
		t.Fatal("expected an error revoking an already REVOKED grant, got nil")
	}
}

func TestCheckAccessLazilyExpiresPastDeadline(t *testing.T) {
	c, ctx, stub := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", "", "", "HospitalZ"); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	if err := c.GrantAccess(ctx, "grant-1", 15, ""); err != nil {
		t.Fatalf("GrantAccess returned error: %v", err)
	}

	// Move the simulated clock forward past the 15-minute window.
	stub.setTxTime(stub.txTime.Add(16 * time.Minute))

	grant, err := c.CheckAccess(ctx, "grant-1")
	if err != nil {
		t.Fatalf("CheckAccess returned error: %v", err)
	}
	if grant.Status != StatusExpired {
		t.Errorf("expected status EXPIRED once past the deadline, got %s", grant.Status)
	}

	// The lazy resolution must persist -- a second read shouldn't need
	// the clock at all to see EXPIRED.
	grantAgain, err := c.CheckAccess(ctx, "grant-1")
	if err != nil {
		t.Fatalf("second CheckAccess returned error: %v", err)
	}
	if grantAgain.Status != StatusExpired {
		t.Errorf("expected persisted status EXPIRED, got %s", grantAgain.Status)
	}
}

func TestCheckAccessDoesNotExpireBeforeDeadline(t *testing.T) {
	c, ctx, stub := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", "", "", "HospitalZ"); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	if err := c.GrantAccess(ctx, "grant-1", 15, ""); err != nil {
		t.Fatalf("GrantAccess returned error: %v", err)
	}
	stub.setTxTime(stub.txTime.Add(5 * time.Minute))

	grant, err := c.CheckAccess(ctx, "grant-1")
	if err != nil {
		t.Fatalf("CheckAccess returned error: %v", err)
	}
	if grant.Status != StatusActive {
		t.Errorf("expected status ACTIVE before the deadline, got %s", grant.Status)
	}
}

// -- break-glass -----------------------------------------------------

func TestBreakGlassAccessActivatesImmediatelyAndFlagsReview(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()

	err := c.BreakGlassAccess(ctx, "grant-bg-1", "did:patientchain:p1", "provider-1", "HospitalA", "HospitalZ", "Unconscious patient, unknown allergy history", "")
	if err != nil {
		t.Fatalf("BreakGlassAccess returned error: %v", err)
	}

	grant, err := c.CheckAccess(ctx, "grant-bg-1")
	if err != nil {
		t.Fatalf("CheckAccess returned error: %v", err)
	}
	if grant.Status != StatusActive {
		t.Errorf("expected break-glass grant to be ACTIVE immediately, got %s", grant.Status)
	}
	if grant.GrantType != GrantTypeBreakGlass {
		t.Errorf("expected grant type BREAK_GLASS, got %s", grant.GrantType)
	}
	if !grant.ReviewRequired {
		t.Error("expected ReviewRequired to be true for a break-glass grant -- a single override must never be the only control")
	}
	if grant.Reviewed {
		t.Error("expected Reviewed to be false immediately after the override")
	}
}

func TestBreakGlassAccessRequiresJustification(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.BreakGlassAccess(ctx, "grant-bg-1", "did:patientchain:p1", "provider-1", "HospitalA", "HospitalZ", "", ""); err == nil {
		t.Fatal("expected an error for a missing justification, got nil")
	}
}

func TestGetPendingBreakGlassReviewsListsUnreviewedOnly(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.BreakGlassAccess(ctx, "grant-bg-1", "did:patientchain:p1", "provider-1", "HospitalA", "HospitalZ", "Emergency", ""); err != nil {
		t.Fatalf("BreakGlassAccess returned error: %v", err)
	}
	if err := c.BreakGlassAccess(ctx, "grant-bg-2", "did:patientchain:p2", "provider-2", "HospitalB", "HospitalZ", "Emergency", ""); err != nil {
		t.Fatalf("BreakGlassAccess returned error: %v", err)
	}

	pending, err := c.GetPendingBreakGlassReviews(ctx)
	if err != nil {
		t.Fatalf("GetPendingBreakGlassReviews returned error: %v", err)
	}
	if len(pending) != 2 {
		t.Fatalf("expected 2 pending reviews, got %d", len(pending))
	}

	if err := c.ReviewBreakGlass(ctx, "grant-bg-1", "admin-1", "Confirmed legitimate emergency"); err != nil {
		t.Fatalf("ReviewBreakGlass returned error: %v", err)
	}

	pendingAfter, err := c.GetPendingBreakGlassReviews(ctx)
	if err != nil {
		t.Fatalf("GetPendingBreakGlassReviews returned error: %v", err)
	}
	if len(pendingAfter) != 1 || pendingAfter[0].GrantID != "grant-bg-2" {
		t.Errorf("expected only grant-bg-2 still pending, got %+v", pendingAfter)
	}
}

func TestReviewBreakGlassRejectsNonBreakGlassGrant(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", "", "", "HospitalZ"); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	if err := c.ReviewBreakGlass(ctx, "grant-1", "admin-1", "notes"); err == nil {
		t.Fatal("expected an error reviewing a standard grant as break-glass, got nil")
	}
}

func TestReviewBreakGlassRejectsDoubleReview(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.BreakGlassAccess(ctx, "grant-bg-1", "did:patientchain:p1", "provider-1", "HospitalA", "HospitalZ", "Emergency", ""); err != nil {
		t.Fatalf("BreakGlassAccess returned error: %v", err)
	}
	if err := c.ReviewBreakGlass(ctx, "grant-bg-1", "admin-1", "first review"); err != nil {
		t.Fatalf("first ReviewBreakGlass returned error: %v", err)
	}
	if err := c.ReviewBreakGlass(ctx, "grant-bg-1", "admin-2", "second review"); err == nil {
		t.Fatal("expected an error on a second review of the same grant, got nil")
	}
}

// -- GetGrantsForPatient -----------------------------------------------

func TestGetGrantsForPatientOnlyReturnsThatPatientsGrants(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", "", "", "HospitalZ"); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	if err := c.RequestAccess(ctx, "grant-2", "did:patientchain:p2", "provider-2", "HospitalB", "", "", "", "HospitalZ"); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}

	grants, err := c.GetGrantsForPatient(ctx, "did:patientchain:p1")
	if err != nil {
		t.Fatalf("GetGrantsForPatient returned error: %v", err)
	}
	if len(grants) != 1 || grants[0].GrantID != "grant-1" {
		t.Errorf("expected exactly grant-1 for p1, got %+v", grants)
	}
}

// ── Patient signatures, batching, hospital index ─────────────────────────

func registerSigningPatient(t *testing.T, stub *fakeStub, did string) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	reg := &PatientRegistryContract{}
	rctx := &contractapi.TransactionContext{}
	rctx.SetStub(stub)
	if err := reg.RegisterPatient(rctx, did, base64.StdEncoding.EncodeToString(der)); err != nil {
		t.Fatal(err)
	}
	return key
}

func signRaw(t *testing.T, key *ecdsa.PrivateKey, msg string) string {
	t.Helper()
	h := sha256.Sum256([]byte(msg))
	r, s, err := ecdsa.Sign(rand.Reader, key, h[:])
	if err != nil {
		t.Fatal(err)
	}
	out := make([]byte, 64)
	r.FillBytes(out[:32])
	s.FillBytes(out[32:])
	return base64.StdEncoding.EncodeToString(out)
}

func TestGrantAccessRequiresValidPatientSignatureWhenKeyRegistered(t *testing.T) {
	c, ctx, stub := newAccessControlCtx()
	key := registerSigningPatient(t, stub, "did:p:signed")
	if err := c.RequestAccess(ctx, "g1", "did:p:signed", "dr-1", "HospitalA", "", "Treatment", "Physician", "HospitalZ"); err != nil {
		t.Fatal(err)
	}
	if err := c.GrantAccess(ctx, "g1", 30, ""); err == nil {
		t.Fatal("expected unsigned grant to be rejected")
	}
	if err := c.GrantAccess(ctx, "g1", 30, signRaw(t, key, "grant:g1:60")); err == nil {
		t.Fatal("expected signature over a different duration to be rejected")
	}
	if err := c.GrantAccess(ctx, "g1", 30, signRaw(t, key, "grant:g1:30")); err != nil {
		t.Fatalf("valid signature rejected: %v", err)
	}
	g, _ := c.CheckAccess(ctx, "g1")
	if !g.PatientSigned || g.ProviderRole != "Physician" {
		t.Fatalf("expected signed grant with role, got %+v", g)
	}
	if err := c.RevokeAccess(ctx, "g1", ""); err == nil {
		t.Fatal("expected unsigned revoke to be rejected")
	}
	if err := c.RevokeAccess(ctx, "g1", signRaw(t, key, "revoke:g1")); err != nil {
		t.Fatalf("signed revoke rejected: %v", err)
	}
}

func TestGrantAccessBatchApprovesAllInOneTransactionOrNone(t *testing.T) {
	c, ctx, stub := newAccessControlCtx()
	key := registerSigningPatient(t, stub, "did:p:b")
	for _, id := range []string{"b1", "b2", "b3"} {
		if err := c.RequestAccess(ctx, id, "did:p:b", "dr-1", "HospitalA", "", "", "", "HospitalZ"); err != nil {
			t.Fatal(err)
		}
	}
	// The fake stub does not roll back a failed transaction (real Fabric
	// does), so the failing item goes first here.
	bad := `[{"grantID":"b2","durationMinutes":10,"signature":""},{"grantID":"b1","durationMinutes":10,"signature":"` + signRaw(t, key, "grant:b1:10") + `"}]`
	if err := c.GrantAccessBatch(ctx, bad); err == nil {
		t.Fatal("expected batch with an unsigned item to fail")
	}
	good := `[{"grantID":"b1","durationMinutes":10,"signature":"` + signRaw(t, key, "grant:b1:10") + `"},{"grantID":"b2","durationMinutes":20,"signature":"` + signRaw(t, key, "grant:b2:20") + `"}]`
	if err := c.GrantAccessBatch(ctx, good); err != nil {
		t.Fatalf("batch failed: %v", err)
	}
	for _, id := range []string{"b1", "b2"} {
		g, _ := c.CheckAccess(ctx, id)
		if g.Status != StatusActive {
			t.Fatalf("%s not active: %s", id, g.Status)
		}
	}
	mine, err := c.GetGrantsForProvider(ctx, "dr-1")
	if err != nil || len(mine) != 3 {
		t.Fatalf("expected 3 grants indexed for dr-1, got %d (%v)", len(mine), err)
	}
	hosp, err := c.GetGrantsForHospital(ctx, "HospitalA")
	if err != nil || len(hosp) != 3 {
		t.Fatalf("expected 3 grants indexed for HospitalA, got %d (%v)", len(hosp), err)
	}
}

func TestCannotRequestOwnHospitalRecords(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "g", "did:p", "dr", "HospitalA", "", "", "", "HospitalA"); err == nil {
		t.Fatal("expected own-hospital request to be rejected")
	}
	if err := c.BreakGlassAccess(ctx, "b", "did:p", "dr", "HospitalA", "HospitalA", "x", ""); err == nil {
		t.Fatal("expected own-hospital break-glass to be rejected")
	}
}

func TestBreakGlassIsOneHourEmergencyScopeAndExtendsToAt24Hours(t *testing.T) {
	c, ctx, stub := newAccessControlCtx()
	if err := c.BreakGlassAccess(ctx, "bg", "did:p", "dr-musa", "JUTH", "Langtang", "unresponsive", "abc123"); err != nil {
		t.Fatal(err)
	}
	g, _ := c.CheckAccess(ctx, "bg")
	granted, _ := parseTS(g.GrantedAt)
	expires, _ := parseTS(g.ExpiresAt)
	if expires.Sub(granted) != time.Hour {
		t.Fatalf("expected 1 hour, got %v", expires.Sub(granted))
	}
	if len(g.Scope) != len(emergencyScope) || g.RequesterHospitalID != "Langtang" || g.RepresentativeHash != "abc123" {
		t.Fatalf("unexpected grant %+v", g)
	}
	if err := c.ExtendBreakGlass(ctx, "bg", "someone-else", "still in theatre", 60); err == nil {
		t.Fatal("only the invoking clinician may extend")
	}
	if err := c.ExtendBreakGlass(ctx, "bg", "dr-musa", "", 60); err == nil {
		t.Fatal("a reason is required")
	}
	for i := 0; i < 30; i++ {
		_ = c.ExtendBreakGlass(ctx, "bg", "dr-musa", "still in ICU", 60)
	}
	g, _ = c.CheckAccess(ctx, "bg")
	expires, _ = parseTS(g.ExpiresAt)
	if expires.Sub(granted) != 24*time.Hour {
		t.Fatalf("expected a 24h cap, got %v", expires.Sub(granted))
	}
	if err := c.ExtendBreakGlass(ctx, "bg", "dr-musa", "more", 60); err == nil {
		t.Fatal("expected refusal past 24 hours")
	}
	_ = stub
}

func TestPatientCanDeclineAPendingRequest(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "g", "did:p", "dr", "JUTH", "", "", "", "Langtang"); err != nil {
		t.Fatal(err)
	}
	if err := c.RevokeAccess(ctx, "g", ""); err != nil {
		t.Fatalf("decline failed: %v", err)
	}
	g, _ := c.CheckAccess(ctx, "g")
	if g.Status != StatusRevoked {
		t.Fatalf("expected REVOKED, got %s", g.Status)
	}
}
