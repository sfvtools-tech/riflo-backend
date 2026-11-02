#!/usr/bin/env bash
# One-time operator install from a reviewed checkout. Not run by release artifacts.
set -euo pipefail
[[ $EUID == 0 && $# == 1 && $1 =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'Usage (root): install-deployer.sh OS_LOGIN_USERNAME' >&2; exit 1; }
cd "$(dirname "$0")"
install -d -o root -g root -m0755 /usr/local/lib/riflo-deploy/cloud
install -o root -g root -m0755 deploy-release.py /usr/local/sbin/riflo-deploy-release
install -o root -g root -m0644 activate-release.sh /usr/local/lib/riflo-deploy/activate-release.sh
install -o root -g root -m0644 cloud/check-caption-fonts.py cloud/check-caption-render.mjs cloud/caption-font-fixtures.json /usr/local/lib/riflo-deploy/cloud/
rule=$(mktemp)
trap 'rm -f "$rule"' EXIT
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/riflo-deploy-release\n' "$1" > "$rule"
visudo -cf "$rule"
install -o root -g root -m0440 "$rule" /etc/sudoers.d/riflo-deployer
