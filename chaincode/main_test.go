package main

import (
	"reflect"
	"strings"
	"testing"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// TestChaincodeMetadataIsValid builds the chaincode exactly as main() does.
// contractapi validates the generated contract metadata here, which is the
// step that failed on a real peer when grant/audit structs exposed
// time.Time fields (see timestamps.go). The fake-stub unit tests call
// contract methods directly and never reach this step, so without this test
// a metadata problem only shows up once the chaincode is deployed.
func TestChaincodeMetadataIsValid(t *testing.T) {
	_, err := contractapi.NewChaincode(
		&PatientRegistryContract{},
		&AccessControlContract{},
		&AuditLogContract{},
		&CostMetricsContract{},
	)
	if err != nil {
		t.Fatalf("chaincode metadata rejected by contractapi: %v", err)
	}
}

// TestOmitemptyFieldsAreOptionalInMetadata guards the runtime counterpart of
// the check above. contractapi validates every value a contract function
// returns against the generated schema, and treats every field as required
// unless it carries a `metadata:",optional"` tag. A field that is
// `json:",omitempty"` disappears from the JSON when empty, so without the
// tag a pending grant (no reviewNotes, no revokedAt, ...) is rejected with
// "Value did not match schema" on a real peer.
func TestOmitemptyFieldsAreOptionalInMetadata(t *testing.T) {
	for _, typ := range []reflect.Type{
		reflect.TypeOf(AccessGrant{}),
		reflect.TypeOf(AuditEntry{}),
		reflect.TypeOf(Patient{}),
		reflect.TypeOf(RecordReference{}),
	} {
		for i := 0; i < typ.NumField(); i++ {
			f := typ.Field(i)
			if strings.Contains(f.Tag.Get("json"), "omitempty") && !strings.Contains(f.Tag.Get("metadata"), "optional") {
				t.Errorf("%s.%s is json omitempty but not metadata optional", typ.Name(), f.Name)
			}
		}
	}
}
