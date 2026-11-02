#!/usr/bin/env bash
# Run inside an isolated Linux amd64 build environment, in extracted backend/.
set -euo pipefail
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
node -e 'if (+process.versions.node.split(".")[0] < 22) process.exit(1)'
npm ci
npm run build
npm prune --omit=dev
node --input-type=module -e 'import sharp from "sharp"; await sharp({create:{width:1,height:1,channels:4,background:"white"}}).png().toBuffer()'
tar -czf "../riflo-$(cat RELEASE)-linux-amd64.tar.gz" dist node_modules package.json package-lock.json RELEASE deploy
