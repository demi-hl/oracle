#!/usr/bin/env bash
# Re-record the hero CLI session. Deterministic: types a fixed script of REAL
# commands against the REAL CLI, so the hero can never drift from what Oracle
# actually does (the previous recording outlived a capability change and was
# still showing hyperevm 999 as fail-closed after it started routing).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=public/oracle-splash/assets/hero
CAST=/tmp/oracle-hero.cast

type_line() {
  local text="$1"
  printf '%s' "$text"
  sleep 0.5
  printf '\n'
}

prompt() { printf '\033[38;5;110moracle\033[0m \033[38;5;245m›\033[0m '; }

# ONE source of truth per command: typed on screen AND executed.
CMD_CHAINS='scan chains'
CMD_QUOTE='scan quote hyperevm 0x5555555555555555555555555555555555555555 0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb 1000000000000000000'

run_demo() {
  clear
  prompt
  type_line "$CMD_CHAINS"
  node bin/oracle.mjs $CMD_CHAINS 2>&1 | head -20
  echo
  sleep 2.5
  prompt
  type_line "$CMD_QUOTE"
  node bin/oracle.mjs $CMD_QUOTE 2>&1 | tail -14 || true
  echo
  sleep 2.5
  prompt
  sleep 1.5
}
export -f type_line prompt run_demo
export CMD_CHAINS CMD_QUOTE

rm -f "$CAST"
asciinema rec "$CAST" --cols 104 --rows 30 --overwrite \
  --command "bash -c run_demo" --quiet

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

agg "$CAST" "$TMP/cli.gif" \
  --theme 0d1117,c9d1d9,000000,ff7b72,3fb950,d29922,58a6ff,bc8cff,39c5cf,b1bac4,6e7681,ffa198,56d364,e3b341,79c0ff,d2a8ff,56d4dd,f0f6fc \
  --font-size 16 --line-height 1.4 --speed 1.0 --fps-cap 30

# Two constraints, both mandatory:
#  - format=yuv420p: agg's GIF decodes as `gbrap` (planar RGB+alpha) and
#    libvpx-vp9 flatly refuses that pixel format. This is what actually broke the
#    earlier encode, not the dimensions.
#  - even width/height: yuv420p chroma subsampling requires it.
SCALE="scale=868:-2:flags=lanczos,crop=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p"

ffmpeg -y -v error -i "$TMP/cli.gif" -vf "$SCALE" \
  -c:v libvpx-vp9 -crf 34 -b:v 0 -an "$TMP/cli.webm"

ffmpeg -y -v error -i "$TMP/cli.gif" -vf "$SCALE" \
  -c:v libx264 -pix_fmt yuv420p -crf 24 -movflags +faststart -an "$TMP/cli.mp4"

ffmpeg -y -v error -ss 6 -i "$TMP/cli.webm" -frames:v 1 -q:v 3 "$TMP/cli.jpg"

# Prove every artifact before it is allowed near the shipped tree.
for f in "$TMP/cli.webm" "$TMP/cli.mp4" "$TMP/cli.jpg"; do
  [ -s "$f" ] || { echo "REFUSING: $f is empty, shipped assets untouched" >&2; exit 1; }
  ffprobe -v error -show_entries stream=width,height -of csv=p=0 "$f" >/dev/null \
    || { echo "REFUSING: $f is not decodable, shipped assets untouched" >&2; exit 1; }
done

mv "$TMP/cli.webm" "$OUT/cli-session.webm"
mv "$TMP/cli.mp4"  "$OUT/cli-session.mp4"
mv "$TMP/cli.jpg"  "$OUT/cli-session-poster.jpg"

ffprobe -v error -show_entries format=duration,size -show_entries stream=width,height \
  -of default=noprint_wrappers=1 "$OUT/cli-session.webm"
