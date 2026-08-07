#!/usr/bin/env bash
# Rebuild the hero orb assets from the Blender source.
#
# The orb is NOT an alpha video. It is a plate baked onto a background colour,
# so each variant needs its own encode against the background it will sit on.
# Alpha builds were tried and rejected: 4.5-7.2MB versus 2.5MB opaque, for an
# effect no page actually needs.
#
# Pitfalls this script encodes, all of which cost real time:
#   * `-pix_fmt yuva420p` placed after `-i` loses to implicit conversion. The
#     format has to be named inside the filter graph.
#   * `overlay` defaults to 25fps and `shortest=1` ends one frame early, which
#     silently yielded 360 and then 431 frames instead of 432. Pin `r=30` on the
#     colour source and use `eof_action=endall`.
#   * ffprobe reports VP9 alpha as plain `yuv420p`; the real signal is the
#     container tag `alpha_mode=1`.
#   * ffmpeg cannot decode VP9 out-of-band alpha, so compositing a frame over
#     white in ffmpeg proves nothing about alpha. Verify in a browser.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../public/oracle-splash/assets/hero"
FRAMES=/tmp/orb30

if [ ! -f "$FRAMES/f_0431.png" ]; then
  echo "rendering 432 frames (Cycles GPU, ~18 min)..."
  blender -b -noaudio -P "$HERE/orb.py"
fi

n=$(ls "$FRAMES"/f_*.png 2>/dev/null | wc -l)
[ "$n" -eq 432 ] || { echo "expected 432 frames, found $n"; exit 1; }

# dark: #0B1018, the splash --bg. ice inherits this one.
ffmpeg -y -v error -framerate 30 -f image2 -pix_fmt rgba -i "$FRAMES/f_%04d.png" \
  -f lavfi -t 14.4 -i "color=0x0B1018:s=900x900:r=30" \
  -filter_complex "[1:v][0:v]overlay=eof_action=endall,fps=30,scale=760:760:flags=lanczos,format=yuv420p[v]" \
  -map "[v]" -c:v libvpx-vp9 -b:v 0 -crf 34 -row-mt 1 -threads 8 -g 60 -an "$OUT/orb.webm"

# ivory: #FBF9F5 paper. Composited with NO blend mode in the variant.
ffmpeg -y -v error -framerate 30 -f image2 -pix_fmt rgba -i "$FRAMES/f_%04d.png" \
  -f lavfi -t 14.4 -i "color=0xFBF9F5:s=900x900:r=30" \
  -filter_complex "[1:v][0:v]overlay=eof_action=endall,fps=30,scale=760:760:flags=lanczos,format=yuv420p[v]" \
  -map "[v]" -c:v libvpx-vp9 -b:v 0 -crf 34 -row-mt 1 -threads 8 -g 60 -an "$OUT/orb-ivory.webm"

for f in "$OUT/orb.webm" "$OUT/orb-ivory.webm"; do
  read -r fps count < <(ffprobe -v error -select_streams v:0 \
    -show_entries stream=r_frame_rate,nb_read_frames -count_frames \
    -of default=nw=1:nk=1 "$f" | tr '\n' ' ')
  echo "$(basename "$f"): $fps, $count frames, $(stat -c%s "$f") bytes"
  [ "$fps" = "30/1" ] || { echo "  FAIL: not 30fps"; exit 1; }
  [ "$count" = "432" ] || { echo "  FAIL: frame count"; exit 1; }
done
echo "ok. bump the ?v= query in index.html and _variants/ or caches keep the old file."
