#!/usr/bin/env bash
# createChannel.sh -- creates patientchainchannel and joins both hospital peers.
set -euo pipefail
cd "$(dirname "$0")/.."

CHANNEL_NAME=patientchainchannel
ORDERER_CA=crypto-config/ordererOrganizations/patientchain.local/orderers/orderer.patientchain.local/tls/ca.crt
ORDERER_ADDR=localhost:7050

peerEnvHospitalA() {
  export CORE_PEER_LOCALMSPID=HospitalAMSP
  export CORE_PEER_TLS_ROOTCERT_FILE=$PWD/crypto-config/peerOrganizations/hospitala.patientchain.local/peers/peer0.hospitala.patientchain.local/tls/ca.crt
  export CORE_PEER_MSPCONFIGPATH=$PWD/crypto-config/peerOrganizations/hospitala.patientchain.local/users/Admin@hospitala.patientchain.local/msp
  export CORE_PEER_ADDRESS=localhost:7051
  export CORE_PEER_TLS_ENABLED=true
}

peerEnvHospitalB() {
  export CORE_PEER_LOCALMSPID=HospitalBMSP
  export CORE_PEER_TLS_ROOTCERT_FILE=$PWD/crypto-config/peerOrganizations/hospitalb.patientchain.local/peers/peer0.hospitalb.patientchain.local/tls/ca.crt
  export CORE_PEER_MSPCONFIGPATH=$PWD/crypto-config/peerOrganizations/hospitalb.patientchain.local/users/Admin@hospitalb.patientchain.local/msp
  export CORE_PEER_ADDRESS=localhost:9051
  export CORE_PEER_TLS_ENABLED=true
}

echo "-- Creating channel from HospitalA --"
peerEnvHospitalA
peer channel create -o "$ORDERER_ADDR" -c "$CHANNEL_NAME" \
  -f ./channel-artifacts/patientchainchannel.tx \
  --outputBlock ./channel-artifacts/${CHANNEL_NAME}.block \
  --tls --cafile "$ORDERER_CA"

echo "-- HospitalA joining channel --"
peer channel join -b ./channel-artifacts/${CHANNEL_NAME}.block

echo "-- HospitalB joining channel --"
peerEnvHospitalB
peer channel join -b ./channel-artifacts/${CHANNEL_NAME}.block

echo "-- Updating anchor peers --"
peerEnvHospitalA
peer channel update -o "$ORDERER_ADDR" -c "$CHANNEL_NAME" \
  -f ./channel-artifacts/HospitalAMSPanchors.tx --tls --cafile "$ORDERER_CA"

peerEnvHospitalB
peer channel update -o "$ORDERER_ADDR" -c "$CHANNEL_NAME" \
  -f ./channel-artifacts/HospitalBMSPanchors.tx --tls --cafile "$ORDERER_CA"

echo "Channel '$CHANNEL_NAME' ready."
