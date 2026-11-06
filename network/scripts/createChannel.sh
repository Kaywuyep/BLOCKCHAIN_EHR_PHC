#!/usr/bin/env bash
# createChannel.sh -- creates patientchainchannel and joins both hospital peers.
set -euo pipefail
cd "$(dirname "$0")/.."
export FABRIC_CFG_PATH="$PWD/config"

CHANNEL_NAME=patientchainchannel
ORDERER_CA="$PWD/crypto-config/ordererOrganizations/patientchain.local/orderers/orderer.patientchain.local/tls/ca.crt"
ORDERER_ADDR=localhost:7050
ORDERER_HOSTNAME=orderer.patientchain.local
ORDERER_ADMIN_ADDR=orderer.patientchain.local:7053
CHANNEL_BLOCK="$PWD/channel-artifacts/${CHANNEL_NAME}.block"
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

if [ ! -f "$CHANNEL_BLOCK" ]; then
  echo "-- Generating channel config block --"
  FABRIC_CFG_PATH="$PWD" configtxgen -profile PatientChainChannel \
    -channelID "$CHANNEL_NAME" -outputBlock "$CHANNEL_BLOCK"
fi

echo "-- Joining orderer to channel --"
docker exec cli osnadmin channel join \
  --channelID "$CHANNEL_NAME" \
  --config-block "$CLI_ROOT/channel-artifacts/${CHANNEL_NAME}.block" \
  --orderer-address "$ORDERER_ADMIN_ADDR" \
  --ca-file "$CLI_ROOT/crypto/ordererOrganizations/patientchain.local/orderers/orderer.patientchain.local/tls/ca.crt" \
  --client-cert "$CLI_ROOT/crypto/ordererOrganizations/patientchain.local/users/Admin@patientchain.local/tls/client.crt" \
  --client-key "$CLI_ROOT/crypto/ordererOrganizations/patientchain.local/users/Admin@patientchain.local/tls/client.key"

echo "-- HospitalA joining channel --"
peerEnvHospitalA
peer channel join -b "$CHANNEL_BLOCK"

echo "-- HospitalB joining channel --"
peerEnvHospitalB
peer channel join -b "$CHANNEL_BLOCK"

echo "Channel '$CHANNEL_NAME' ready."
