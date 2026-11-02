#!/bin/bash
set -euo pipefail
python3 -m venv /opt/riflo-tools
/opt/riflo-tools/bin/pip install 'yt-dlp[default]==2026.10.26' 'yt-dlp-ejs==0.8.0'
archive=ffmpeg-n9.0.2-42-gd7643a0fe3-linux64-gpl-9.0.tar.xz
url=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-01-12-49
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
curl -fL "$url/$archive" -o "$stage/$archive"
printf "%s  %s\n" 11570b7bb1436ff432c91202ae0e7ea4be65359fd06650e18935c1ee9d005bf6 "$stage/$archive" | sha256sum -c -
tar -xJf "$stage/$archive" -C "$stage"
install -m0755 "$stage/${archive%.tar.xz}/bin/ffmpeg" /usr/local/bin/ffmpeg
install -m0755 "$stage/${archive%.tar.xz}/bin/ffprobe" /usr/local/bin/ffprobe
/usr/local/bin/ffmpeg -hide_banner -h protocol=http 2>&1 | grep -E 'request_size|multiple_requests|short_seek_size'
/opt/riflo-tools/bin/yt-dlp --version
