#!/usr/bin/env bash
# Package current sources, never macOS native dependencies or local credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
release="$(date -u +%Y%m%dT%H%M%SZ)"
out="${1:-$PWD/artifacts/releases}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/backend"
cp package.json package-lock.json tsconfig.json tsconfig.build.json "$stage/backend/"
cp -R src deploy "$stage/backend/"
printf '%s\n' "$release" > "$stage/backend/RELEASE"
tar -czf "$out/riflo-$release-source.tar.gz" -C "$stage" backend
shasum -a 256 "$out/riflo-$release-source.tar.gz" > "$out/riflo-$release-source.tar.gz.sha256"
printf '%s\n' "$out/riflo-$release-source.tar.gz"
