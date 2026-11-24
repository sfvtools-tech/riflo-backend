#!/bin/bash
set -euo pipefail
python_bin=${PYTHON_BIN:-python3}
command -v "$python_bin" >/dev/null
"$python_bin" -c 'import sys; assert sys.version_info >= (3, 11), "yt-dlp requires Python 3.11 or newer"'
"$python_bin" -m venv /opt/riflo-tools
/opt/riflo-tools/bin/pip install 'yt-dlp[default]==2026.10.26' 'yt-dlp-ejs==0.8.0'
archive=ffmpeg-n9.0.2-39-g7adfbe40dc-linux64-gpl-9.0.tar.xz
# Upstream prunes daily builds after about two weeks; only month-end builds are retained.
url=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
curl -fL "$url/$archive" -o "$stage/$archive"
printf "%s  %s\n" 73e29a56974ae5a651133a04584c7483b21afe941e17dc91d79814a758b608d3 "$stage/$archive" | sha256sum -c -
tar -xJf "$stage/$archive" -C "$stage"
install -m0755 "$stage/${archive%.tar.xz}/bin/ffmpeg" /usr/local/bin/ffmpeg
install -m0755 "$stage/${archive%.tar.xz}/bin/ffprobe" /usr/local/bin/ffprobe
/usr/local/bin/ffmpeg -hide_banner -h protocol=http 2>&1 | grep -E 'request_size|multiple_requests|short_seek_size'
/opt/riflo-tools/bin/yt-dlp --version
