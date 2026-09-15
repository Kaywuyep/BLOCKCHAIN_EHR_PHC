#!/usr/bin/env bash
# network-up.sh
# Brings up the PatientChain pilot network: generates MSP/TLS material,
# creates the genesis block, starts the orderer + two hospital peers,
# and joins them to "patientchainchannel".
#
# Prerequisites (on your machine, not in this sandbox):
#   - Docker + Docker Compose
#   - Fabric binaries (cryptogen, configtxgen, peer) on PATH.
#     Get them via the official bootstrap script:
#     curl -sSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/bootstrap.sh | bash -s -- 2.5.4 1.5.7
#
# Usage: ./scripts/network-up.sh

set -euo pipefail
cd "$(dirname "$0")/.."   # run from network/

echo "== 1. Generating crypto material =="
rm -rf crypto-config
cryptogen generate --config=./crypto-config.yaml --output="crypto-config"

echo "== 2. Generating genesis block and channel artifacts =="
rm -rf channel-artifacts
mkdir -p channel-artifacts
export FABRIC_CFG_PATH=$PWD
configtxgen -profile PatientChainGenesis -channelID system-channel -outputBlock ./channel-artifacts/genesis.block
configtxgen -profile PatientChainChannel -outputCreateChannelTx ./channel-artifacts/patientchainchannel.tx -channelID patientchainchannel
configtxgen -profile PatientChainChannel -outputAnchorPeersUpdate ./channel-artifacts/HospitalAMSPanchors.tx -channelID patientchainchannel -asOrg HospitalAMSP
configtxgen -profile PatientChainChannel -outputAnchorPeersUpdate ./channel-artifacts/HospitalBMSPanchors.tx -channelID patientchainchannel -asOrg HospitalBMSP

echo "== 3. Starting containers =="
docker compose -f docker-compose.yaml up -d

echo "== 4. Waiting for orderer/peers to come up =="
sleep 8

echo "== 5. Creating and joining the channel =="
./scripts/createChannel.sh

echo ""
echo "Network is up. Channel 'patientchainchannel' created and joined by HospitalA and HospitalB."
echo "Next: ./scripts/deployChaincode.sh"
