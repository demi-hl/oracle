#!/usr/bin/env bash
# Record a real Oracle CLI session to an asciicast.
# Runs actual commands against live chains. No mocked output, no fake data.
set -euo pipefail

OUT="${1:-/tmp/oracle-cast.cast}"
SCENE="${2:-session}"
COLS=92
ROWS=20

# Record the code in THIS worktree, not whatever global build happens to be
# installed. A recording of stale code is worse than no recording.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ORACLE_BIN="$REPO/packages/oracle/bin"
oracle_route() { node "$ORACLE_BIN/oracle-route.mjs" "$@"; }
oracle_scan()  { node "$ORACLE_BIN/oracle-scan.mjs" "$@"; }

# Typed at ~human speed so the recording reads as a session, not a dump.
type_out() {
  local s="$1"
  for ((i = 0; i < ${#s}; i++)); do
    printf '%s' "${s:i:1}"
    sleep 0.035
  done
  printf '\n'
}

prompt() { printf '\033[38;2;184;240;255moracle\033[0m \033[38;2;111;168;255m›\033[0m '; }

session() {
  sleep 0.8

  prompt; type_out '/chain hyperliquid'
  sleep 0.35
  node "$ORACLE_BIN/oracle-chain.mjs" use hyperliquid 2>&1 | head -6 || true
  sleep 1.1

  prompt; type_out 'scan head hyperevm'
  sleep 0.35
  oracle_scan head hyperevm 2>&1 | head -8
  sleep 1.4

  prompt; type_out 'scan chains'
  sleep 0.35
  oracle_scan chains 2>&1 | head -14
  sleep 1.8

  prompt
  sleep 0.9
}

# Scene 2: best execution. This is the product argument in one screen --
# several venues quoted, ranked net of cost, with honest warnings.
route_scene() {
  sleep 0.8
  prompt; type_out 'route swap base WETH USDC 1.0'
  sleep 0.35
  oracle_route swap base \
    0x4200000000000000000000000000000000000006 \
    0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
    1000000000000000000 2>&1 | head -16
  sleep 2.6
  prompt
  sleep 0.9
}

risk_scene() {
  sleep 0.8
  prompt; type_out 'scan risk base USDC'
  sleep 0.35
  oracle_scan risk base 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 2>&1 | head -12
  sleep 2.4
  prompt
  sleep 0.9
}

export -f type_out prompt session route_scene risk_scene oracle_route oracle_scan
# asciinema 3.x uses --window-size COLSxROWS. The older --cols/--rows flags are
# silently ignored in headless mode, which leaves a dead band under the session.
COLUMNS="$COLS" LINES="$ROWS" asciinema rec "$OUT" \
  --window-size "${COLS}x${ROWS}" \
  --overwrite \
  --command "bash -lc $SCENE"

echo "cast written: $OUT"
