#!/usr/bin/env bash
# Run during provisioning or deliberate runtime maintenance, never each release.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y fonts-noto-core fonts-noto-cjk
fc-cache -f
# The accepted manifest must live outside riflo's writable home.
install -d -o root -g riflo -m 0750 /etc/riflo
manifest=$(mktemp /etc/riflo/.caption-font-packages.XXXXXX)
trap 'rm -f -- "$manifest"' EXIT
dpkg-query -W '-f=${Package}\t${Version}\n' fonts-noto-core fonts-noto-cjk > "$manifest"
chown root:riflo "$manifest"
chmod 0640 "$manifest"
mv -fT -- "$manifest" /etc/riflo/caption-font-packages.tsv
