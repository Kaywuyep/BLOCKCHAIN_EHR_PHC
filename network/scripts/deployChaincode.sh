#!/usr/bin/env bash
# deployChaincode.sh -- packages, installs, approves and commits the
# PatientChain chaincode (patientregistry + accesscontrol + auditlog +
# costmetrics, one chaincode package) on both hospital peers.
set -euo pipefail
cd "$(dirname "$0")/.."
export FABRIC_CFG_PATH="$PWD/config"

CHANNEL_NAME=patientchainchannel
CC_NAME=patientchain
CC_VERSION=1.0
CC_SEQUENCE=1
CC_SRC_PATH="$PWD/../chaincode"
ORDERER_CA="$PWD/crypto-config/ordererOrganizations/patientchain.local/orderers/orderer.patientchain.local/tls/ca.crt"
ORDERER_ADDR=localhost:7050
ORDERER_HOSTNAME=orderer.patientchain.local
CLI_ROOT=/opt/gopath/src/github.com/hyperledger/fabric/peer

peerEnvHospitalA() {
  export CORE_PEER_LOCALMSPID=HospitalAMSP
  export CORE_PEER_TLS_ROOTCERT_FILE=$PWD/crypto-config/peerOrganizations/hospitala.patientchain.local/peers/peer0.hospitala.patientchain.local/tls/ca.crt
  export CORE_PEER_MSPCONFIGPATH=$PWD/crypto-config/peerOrganizations/hospitala.patientchain.local/users/Admin@hospitala.patientchain.local/msp
  export CORE_PEER_ADDRESS=localhost:7051
  export CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_TLS_SERVERHOSTOVERRIDE=peer0.hospitala.patientchain.local
}

peerEnvHospitalB() {
  export CORE_PEER_LOCALMSPID=HospitalBMSP
  export CORE_PEER_TLS_ROOTCERT_FILE=$PWD/crypto-config/peerOrganizations/hospitalb.patientchain.local/peers/peer0.hospitalb.patientchain.local/tls/ca.crt
  export CORE_PEER_MSPCONFIGPATH=$PWD/crypto-config/peerOrganizations/hospitalb.patientchain.local/users/Admin@hospitalb.patientchain.local/msp
  export CORE_PEER_ADDRESS=localhost:9051
  export CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_TLS_SERVERHOSTOVERRIDE=peer0.hospitalb.patientchain.local
}

echo "-- Vendoring chaincode Go modules --"
pushd "$CC_SRC_PATH" > /dev/null
GO111MODULE=on go mod vendor
popd > /dev/null

echo "-- Packaging chaincode --"
peer lifecycle chaincode package ${CC_NAME}.tar.gz \
  --path "$CC_SRC_PATH" --lang golang --label ${CC_NAME}_${CC_VERSION}

echo "-- Installing on HospitalA peer --"
peerEnvHospitalA
peer lifecycle chaincode install ${CC_NAME}.tar.gz

echo "-- Installing on HospitalB peer --"
peerEnvHospitalB
peer lifecycle chaincode install ${CC_NAME}.tar.gz

PACKAGE_ID=$(peer lifecycle chaincode queryinstalled | grep "${CC_NAME}_${CC_VERSION}" | sed -n 's/^Package ID: \(.*\), Label:.*/\1/p')
echo "Package ID: $PACKAGE_ID"

echo "-- Approving for HospitalA --"
peerEnvHospitalA
peer lifecycle chaincode approveformyorg -o "$ORDERER_ADDR" --tls --cafile "$ORDERER_CA" \
  --ordererTLSHostnameOverride "$ORDERER_HOSTNAME" \
  --channelID "$CHANNEL_NAME" --name "$CC_NAME" --version "$CC_VERSION" \
  --package-id "$PACKAGE_ID" --sequence "$CC_SEQUENCE"

echo "-- Approving for HospitalB --"
peerEnvHospitalB
peer lifecycle chaincode approveformyorg -o "$ORDERER_ADDR" --tls --cafile "$ORDERER_CA" \
  --ordererTLSHostnameOverride "$ORDERER_HOSTNAME" \
  --channelID "$CHANNEL_NAME" --name "$CC_NAME" --version "$CC_VERSION" \
  --package-id "$PACKAGE_ID" --sequence "$CC_SEQUENCE"

echo "-- Checking commit readiness --"
peer lifecycle chaincode checkcommitreadiness --channelID "$CHANNEL_NAME" --name "$CC_NAME" \
  --version "$CC_VERSION" --sequence "$CC_SEQUENCE" --output json

echo "-- Committing chaincode definition --"
docker exec cli peer lifecycle chaincode commit \
  -o orderer.patientchain.local:7050 \
  --tls --cafile "$CLI_ROOT/crypto/ordererOrganizations/patientchain.local/orderers/orderer.patientchain.local/tls/ca.crt" \
  --ordererTLSHostnameOverride "$ORDERER_HOSTNAME" \
  --channelID "$CHANNEL_NAME" --name "$CC_NAME" --version "$CC_VERSION" --sequence "$CC_SEQUENCE" \
  --peerAddresses peer0.hospitala.patientchain.local:7051 \
  --tlsRootCertFiles "$CLI_ROOT/crypto/peerOrganizations/hospitala.patientchain.local/peers/peer0.hospitala.patientchain.local/tls/ca.crt" \
  --peerAddresses peer0.hospitalb.patientchain.local:9051 \
  --tlsRootCertFiles "$CLI_ROOT/crypto/peerOrganizations/hospitalb.patientchain.local/peers/peer0.hospitalb.patientchain.local/tls/ca.crt"

echo "Chaincode '$CC_NAME' committed on channel '$CHANNEL_NAME'."
