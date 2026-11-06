package main

import (
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

	err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", `["Observation","MedicationRequest"]`, "Treatment")
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
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", ""); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	grant, _ := c.CheckAccess(ctx, "grant-1")
	if grant.Purpose != "Treatment" {
		t.Errorf("expected default purpose Treatment, got %s", grant.Purpose)
	}
}

func TestRequestAccessRejectsDuplicateGrantID(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", ""); err != nil {
		t.Fatalf("first RequestAccess returned error: %v", err)
	}
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-2", "HospitalB", "", ""); err == nil {
		t.Fatal("expected an error reusing an existing grantID, got nil")
	}
}

func TestRequestAccessRejectsInvalidScopeJSON(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "not-json", ""); err == nil {
		t.Fatal("expected an error for malformed scope JSON, got nil")
	}
}

func TestGrantAccessActivatesPendingGrant(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", ""); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}

	if err := c.GrantAccess(ctx, "grant-1", 30); err != nil {
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
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", ""); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	if err := c.GrantAccess(ctx, "grant-1", 30); err != nil {
		t.Fatalf("first GrantAccess returned error: %v", err)
	}
	if err := c.GrantAccess(ctx, "grant-1", 30); err == nil {
		t.Fatal("expected an error granting an already-ACTIVE grant, got nil")
	}
}

func TestGrantAccessRejectsNonPositiveDuration(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", ""); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	if err := c.GrantAccess(ctx, "grant-1", 0); err == nil {
		t.Fatal("expected an error for a zero duration, got nil")
	}
}

func TestRevokeAccessEndsActiveGrant(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", ""); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	if err := c.GrantAccess(ctx, "grant-1", 30); err != nil {
		t.Fatalf("GrantAccess returned error: %v", err)
	}
	if err := c.RevokeAccess(ctx, "grant-1"); err != nil {
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
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", ""); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	// Still PENDING -- never granted.
	if err := c.RevokeAccess(ctx, "grant-1"); err == nil {
		t.Fatal("expected an error revoking a PENDING grant, got nil")
	}
}

func TestCheckAccessLazilyExpiresPastDeadline(t *testing.T) {
	c, ctx, stub := newAccessControlCtx()
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", ""); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	if err := c.GrantAccess(ctx, "grant-1", 15); err != nil {
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
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", ""); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	if err := c.GrantAccess(ctx, "grant-1", 15); err != nil {
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

	err := c.BreakGlassAccess(ctx, "grant-bg-1", "did:patientchain:p1", "provider-1", "HospitalA", "Unconscious patient, unknown allergy history")
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
	if err := c.BreakGlassAccess(ctx, "grant-bg-1", "did:patientchain:p1", "provider-1", "HospitalA", ""); err == nil {
		t.Fatal("expected an error for a missing justification, got nil")
	}
}

func TestGetPendingBreakGlassReviewsListsUnreviewedOnly(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.BreakGlassAccess(ctx, "grant-bg-1", "did:patientchain:p1", "provider-1", "HospitalA", "Emergency"); err != nil {
		t.Fatalf("BreakGlassAccess returned error: %v", err)
	}
	if err := c.BreakGlassAccess(ctx, "grant-bg-2", "did:patientchain:p2", "provider-2", "HospitalB", "Emergency"); err != nil {
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
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", ""); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	if err := c.ReviewBreakGlass(ctx, "grant-1", "admin-1", "notes"); err == nil {
		t.Fatal("expected an error reviewing a standard grant as break-glass, got nil")
	}
}

func TestReviewBreakGlassRejectsDoubleReview(t *testing.T) {
	c, ctx, _ := newAccessControlCtx()
	if err := c.BreakGlassAccess(ctx, "grant-bg-1", "did:patientchain:p1", "provider-1", "HospitalA", "Emergency"); err != nil {
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
	if err := c.RequestAccess(ctx, "grant-1", "did:patientchain:p1", "provider-1", "HospitalA", "", ""); err != nil {
		t.Fatalf("RequestAccess returned error: %v", err)
	}
	if err := c.RequestAccess(ctx, "grant-2", "did:patientchain:p2", "provider-2", "HospitalB", "", ""); err != nil {
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
