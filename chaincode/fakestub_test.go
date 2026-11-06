package main

// fakestub_test.go implements a minimal, in-memory double for
// shim.ChaincodeStubInterface and cid.ClientIdentity, so each contract's
// unit tests can call its methods directly -- exactly as contractapi's
// own router does at runtime -- without a running Fabric peer.
//
// This file stands in for the test-only `shimtest.MockStub` helper used by
// earlier chaincode tutorials.
// It only implements the subset of behaviour our four contracts actually
// exercise (simple key CRUD, composite-key range queries, tx timestamp,
// events, caller identity); every other interface method returns a
// "not implemented" error so a test that accidentally depends on
// unimplemented behaviour fails loudly instead of silently no-op-ing.

import (
	"crypto/x509"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/hyperledger/fabric-chaincode-go/shim"
	"github.com/hyperledger/fabric-protos-go/ledger/queryresult"
	"github.com/hyperledger/fabric-protos-go/peer"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type fakeStub struct {
	state  map[string][]byte
	txTime time.Time
	txID   string
	reads  int // number of GetState / partial-key reads, for hotspot tests

	lastEventName    string
	lastEventPayload []byte
}

func newFakeStub() *fakeStub {
	return &fakeStub{
		state:  map[string][]byte{},
		txTime: time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC),
		txID:   "tx-0",
	}
}

// setTxTime lets a test simulate transactions happening at different
// points in time (e.g. to exercise grant expiry).
func (f *fakeStub) setTxTime(t time.Time) { f.txTime = t }

// -- state CRUD -------------------------------------------------------

func (f *fakeStub) GetState(key string) ([]byte, error) {
	f.reads++
	return f.state[key], nil
}

func (f *fakeStub) PutState(key string, value []byte) error {
	f.state[key] = value
	return nil
}

func (f *fakeStub) DelState(key string) error {
	delete(f.state, key)
	return nil
}

// -- composite keys -----------------------------------------------------
// Delegate to the real shim package so key encoding matches production
// exactly, instead of reimplementing the delimiter/escaping rules here.

func (f *fakeStub) CreateCompositeKey(objectType string, attributes []string) (string, error) {
	return shim.CreateCompositeKey(objectType, attributes)
}

func (f *fakeStub) SplitCompositeKey(compositeKey string) (string, []string, error) {
	return (&shim.ChaincodeStub{}).SplitCompositeKey(compositeKey)
}

func (f *fakeStub) GetStateByPartialCompositeKey(objectType string, keys []string) (shim.StateQueryIteratorInterface, error) {
	f.reads++
	prefix, err := shim.CreateCompositeKey(objectType, keys)
	if err != nil {
		return nil, err
	}
	allKeys := make([]string, 0, len(f.state))
	for k := range f.state {
		allKeys = append(allKeys, k)
	}
	sort.Strings(allKeys)

	var items []*queryresult.KV
	for _, k := range allKeys {
		if strings.HasPrefix(k, prefix) {
			items = append(items, &queryresult.KV{Key: k, Value: f.state[k]})
		}
	}
	return &fakeIterator{items: items}, nil
}

// -- tx metadata, events, identity ---------------------------------------

func (f *fakeStub) GetTxTimestamp() (*timestamppb.Timestamp, error) {
	return timestamppb.New(f.txTime), nil
}

func (f *fakeStub) GetTxID() string { return f.txID }

func (f *fakeStub) SetEvent(name string, payload []byte) error {
	f.lastEventName = name
	f.lastEventPayload = payload
	return nil
}

// -- everything else: unused by these contracts, fails loudly if called --

func (f *fakeStub) GetArgs() [][]byte                            { return nil }
func (f *fakeStub) GetStringArgs() []string                      { return nil }
func (f *fakeStub) GetFunctionAndParameters() (string, []string) { return "", nil }
func (f *fakeStub) GetArgsSlice() ([]byte, error) {
	return nil, fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) GetChannelID() string { return "mychannel" }
func (f *fakeStub) InvokeChaincode(string, [][]byte, string) peer.Response {
	return peer.Response{Status: 500, Message: "fakeStub: not implemented"}
}
func (f *fakeStub) SetStateValidationParameter(string, []byte) error {
	return fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) GetStateValidationParameter(string) ([]byte, error) {
	return nil, fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) GetStateByRange(string, string) (shim.StateQueryIteratorInterface, error) {
	return nil, fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) GetStateByRangeWithPagination(string, string, int32, string) (shim.StateQueryIteratorInterface, *peer.QueryResponseMetadata, error) {
	return nil, nil, fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) GetStateByPartialCompositeKeyWithPagination(string, []string, int32, string) (shim.StateQueryIteratorInterface, *peer.QueryResponseMetadata, error) {
	return nil, nil, fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) GetQueryResult(string) (shim.StateQueryIteratorInterface, error) {
	return nil, fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) GetQueryResultWithPagination(string, int32, string) (shim.StateQueryIteratorInterface, *peer.QueryResponseMetadata, error) {
	return nil, nil, fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) GetHistoryForKey(string) (shim.HistoryQueryIteratorInterface, error) {
	return nil, fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) GetPrivateData(string, string) ([]byte, error) {
	return nil, fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) GetPrivateDataHash(string, string) ([]byte, error) {
	return nil, fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) PutPrivateData(string, string, []byte) error {
	return fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) DelPrivateData(string, string) error {
	return fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) PurgePrivateData(string, string) error {
	return fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) SetPrivateDataValidationParameter(string, string, []byte) error {
	return fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) GetPrivateDataValidationParameter(string, string) ([]byte, error) {
	return nil, fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) GetPrivateDataByRange(string, string, string) (shim.StateQueryIteratorInterface, error) {
	return nil, fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) GetPrivateDataByPartialCompositeKey(string, string, []string) (shim.StateQueryIteratorInterface, error) {
	return nil, fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) GetPrivateDataQueryResult(string, string) (shim.StateQueryIteratorInterface, error) {
	return nil, fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) GetCreator() ([]byte, error) { return nil, fmt.Errorf("fakeStub: not implemented") }
func (f *fakeStub) GetTransient() (map[string][]byte, error) {
	return nil, fmt.Errorf("fakeStub: not implemented")
}
func (f *fakeStub) GetBinding() ([]byte, error)       { return nil, fmt.Errorf("fakeStub: not implemented") }
func (f *fakeStub) GetDecorations() map[string][]byte { return nil }
func (f *fakeStub) GetSignedProposal() (*peer.SignedProposal, error) {
	return nil, fmt.Errorf("fakeStub: not implemented")
}

// -- iterator -------------------------------------------------------------

type fakeIterator struct {
	items []*queryresult.KV
	idx   int
}

func (it *fakeIterator) HasNext() bool { return it.idx < len(it.items) }

func (it *fakeIterator) Close() error { return nil }

func (it *fakeIterator) Next() (*queryresult.KV, error) {
	if !it.HasNext() {
		return nil, fmt.Errorf("fakeIterator: no more items")
	}
	kv := it.items[it.idx]
	it.idx++
	return kv, nil
}

// -- client identity --------------------------------------------------

type fakeClientIdentity struct {
	id string
}

func (f *fakeClientIdentity) GetID() (string, error)                         { return f.id, nil }
func (f *fakeClientIdentity) GetMSPID() (string, error)                      { return "HospitalAMSP", nil }
func (f *fakeClientIdentity) GetAttributeValue(string) (string, bool, error) { return "", false, nil }
func (f *fakeClientIdentity) AssertAttributeValue(string, string) error {
	return fmt.Errorf("fakeClientIdentity: not implemented")
}
func (f *fakeClientIdentity) GetX509Certificate() (*x509.Certificate, error) { return nil, nil }
