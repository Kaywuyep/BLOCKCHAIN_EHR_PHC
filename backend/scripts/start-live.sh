#!/usr/bin/env bash
# start-live.sh — runs the backend for a real (non-demo) test:
#   Hyperledger Fabric ledger, password accounts, no demo data,
#   its own data directory (data/live), HL7 MLLP listeners on.
#
# First start prints the system admin's temporary password once:
#   username: superadmin
# Change it at first sign-in. The token-signing secret is generated once
# and kept in data/live/.jwt-secret (mode 600), so sign-ins survive restarts.
#
# Needs the Fabric network up (network/scripts/network-up.sh +
# deployChaincode.sh) and Node 22.
set -euo pipefail
cd "$(dirname "$0")/.."

export DATA_DIR="${DATA_DIR:-$PWD/data/live}"
mkdir -p "$DATA_DIR"
SECRET_FILE="$DATA_DIR/.jwt-secret"
if [ ! -s "$SECRET_FILE" ]; then
  (umask 077 && node -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64url'))" > "$SECRET_FILE")
fi

export AUTH_MODE=password
export AUTH_JWT_SECRET="$(cat "$SECRET_FILE")"
export LEDGER_MODE=fabric
export DEMO_SEED=off
export HL7_MLLP_ENABLED=true
export PORT="${PORT:-6000}"

exec node src/server.js
