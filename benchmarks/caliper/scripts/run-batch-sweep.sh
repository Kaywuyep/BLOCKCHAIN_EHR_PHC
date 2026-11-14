#!/usr/bin/env bash
# run-batch-sweep.sh -- runs the Caliper benchmark once per orderer batch size
# b (BatchSize.MaxMessageCount) and stores each run under results/b-<n>/.
#
# WHY THE NETWORK MUST BE RECREATED
#   b is a channel-configuration value. network-up.sh builds the channel's
#   genesis block from network/configtx.yaml (FABRIC_CFG_PATH=network/), so
#   changing b means: edit Orderer.BatchSize.MaxMessageCount in
#   network/configtx.yaml, tear the network down WITH its volumes (the old
#   ledger still carries the old channel config), bring it back up and
#   redeploy the chaincode:
#
#       cd network
#       docker compose -f docker-compose.yaml down -v
#       ./scripts/network-up.sh
#       ./scripts/deployChaincode.sh
#
#   (A live channel-config update with configtxlator would also work but is
#   not scripted here; recreating keeps every b on an identical empty ledger.)
#
# MODES
#   (default)   Manual: for each b, prints the steps above and waits until you
#               have done them, checks configtx.yaml carries the right value,
#               then runs Caliper.
#   --auto      Does the edit + teardown + network-up + deploy for you, then
#               runs Caliper. DESTROYS the running network's ledger. The
#               original configtx.yaml is restored when the script exits.
#   --current N Runs Caliper once against the network as it is now and files
#               the results under results/b-N/ (you have set up b=N yourself).
#
# ENVIRONMENT
#   BATCH_SIZES   space-separated list (default "1 2 5 10 20 50")
#   BENCH_CONFIG  bench config relative to the workspace (default benchmarks/config.yaml)
#
# Output per run: results/b-<n>/report.html, caliper.log, raw/*.json (ms-precision
# per-worker stats written by the workload modules) and meta.txt.
# Then: node scripts/fit-curve.js --results results

set -euo pipefail

WS="$(cd "$(dirname "$0")/.." && pwd)"          # benchmarks/caliper
REPO="$(cd "$WS/../.." && pwd)"
NET="$REPO/network"
CONFIGTX="$NET/configtx.yaml"
BATCH_SIZES="${BATCH_SIZES:-1 2 5 10 20 50}"
BENCH_CONFIG="${BENCH_CONFIG:-benchmarks/config.yaml}"

MODE=manual
CURRENT_B=""

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --auto) MODE=auto ;;
    --current) MODE=current; CURRENT_B="${2:?--current needs a batch size}"; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
  shift
done

current_mmc() { awk '/^[[:space:]]*MaxMessageCount:/ {print $2; exit}' "$CONFIGTX"; }
current_timeout() { awk '/^[[:space:]]*BatchTimeout:/ {print $2; exit}' "$CONFIGTX"; }

set_mmc() {
  sed -i -E "s/^([[:space:]]*MaxMessageCount:[[:space:]]*)[0-9]+/\1$1/" "$CONFIGTX"
  [ "$(current_mmc)" = "$1" ] || { echo "Failed to set MaxMessageCount=$1 in $CONFIGTX" >&2; exit 1; }
}

recreate_network() {
  echo "== Recreating the Fabric network with MaxMessageCount=$1 =="
  (cd "$NET" && docker compose -f docker-compose.yaml down -v)
  # Chaincode containers are started by the peers, not by compose.
  local cc
  cc="$(docker ps -aq --filter name=dev-peer || true)"
  [ -n "$cc" ] && docker rm -f $cc >/dev/null
  "$NET/scripts/network-up.sh"
  "$NET/scripts/deployChaincode.sh"
}

ensure_bound() {
  cd "$WS"
  if [ ! -d node_modules/@hyperledger/caliper-cli ]; then
    echo "== Installing Caliper (npm install) =="
    npm install
  fi
  if [ ! -d node_modules/@hyperledger/fabric-gateway ]; then
    echo "== Binding Caliper to fabric:2.5 =="
    npx caliper bind --caliper-bind-sut fabric:2.5
  fi
}

run_caliper() {
  local b="$1"
  local out="$WS/results/b-$b"
  rm -rf "$out"
  mkdir -p "$out/raw"
  {
    echo "batch_size_MaxMessageCount=$b"
    echo "configtx_MaxMessageCount=$(current_mmc)"
    echo "BatchTimeout=$(current_timeout)"
    echo "bench_config=$BENCH_CONFIG"
    echo "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "git_rev=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    echo "node=$(node --version)"
    echo "host=$(uname -srm)"
  } > "$out/meta.txt"

  echo "== Running Caliper for b=$b (results -> results/b-$b) =="
  cd "$WS"
  BENCH_RAW_DIR="$out/raw" BENCH_RUN_TAG="b$b-$(date +%s)" \
    npx caliper launch manager \
      --caliper-workspace ./ \
      --caliper-networkconfig networks/fabric-network.yaml \
      --caliper-benchconfig "$BENCH_CONFIG" \
      --caliper-flow-only-test \
      --caliper-fabric-timeout-invokeorquery 120 \
      --caliper-report-path "results/b-$b/report.html" \
    2>&1 | tee "$out/caliper.log"
  echo "finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$out/meta.txt"
}

ensure_bound

case "$MODE" in
  current)
    if [ "$(current_mmc)" != "$CURRENT_B" ]; then
      echo "WARNING: network/configtx.yaml has MaxMessageCount=$(current_mmc), not $CURRENT_B." >&2
      echo "         The results will be filed under b-$CURRENT_B regardless." >&2
    fi
    run_caliper "$CURRENT_B"
    ;;

  auto)
    BACKUP="$(mktemp)"
    cp "$CONFIGTX" "$BACKUP"
    trap 'cp "$BACKUP" "$CONFIGTX"; rm -f "$BACKUP"; echo "Restored original network/configtx.yaml"' EXIT
    for b in $BATCH_SIZES; do
      set_mmc "$b"
      recreate_network "$b"
      run_caliper "$b"
    done
    echo "NOTE: the network is still running with MaxMessageCount=$(echo $BATCH_SIZES | awk '{print $NF}');"
    echo "      configtx.yaml has been restored -- recreate the network to return to the default."
    ;;

  manual)
    for b in $BATCH_SIZES; do
      cat <<EOF

=====================================================================
 Batch size b = $b
=====================================================================
 1. Edit $CONFIGTX:
        Orderer: -> BatchSize: -> MaxMessageCount: $b
    (currently: $(current_mmc); BatchTimeout: $(current_timeout))
 2. Recreate the network and redeploy the chaincode:
        cd $NET
        docker compose -f docker-compose.yaml down -v
        docker rm -f \$(docker ps -aq --filter name=dev-peer) 2>/dev/null || true
        ./scripts/network-up.sh
        ./scripts/deployChaincode.sh
EOF
      while true; do
        read -r -p " Press Enter when done, 's' to skip b=$b, 'q' to quit: " ans
        case "$ans" in
          q|Q) exit 0 ;;
          s|S) continue 2 ;;
          *)
            if [ "$(current_mmc)" = "$b" ]; then
              break
            fi
            echo " configtx.yaml still says MaxMessageCount=$(current_mmc) (expected $b)."
            ;;
        esac
      done
      run_caliper "$b"
    done
    ;;
esac

echo ""
echo "Done. Fit the curve with:  node scripts/fit-curve.js --results results --out results/fit"
