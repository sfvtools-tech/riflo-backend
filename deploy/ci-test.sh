#!/usr/bin/env bash
set -euo pipefail
: "${FIREBASE_AUTH_EMULATOR_HOST:?}" "${FIRESTORE_EMULATOR_HOST:?}" "${FIREBASE_STORAGE_EMULATOR_HOST:?}"
: "${FFMPEG_PATH:?}" "${FFPROBE_PATH:?}" "${YT_DLP_PATH:?}"
[[ -x $FFMPEG_PATH && -x $FFPROBE_PATH && -x $YT_DLP_PATH ]]
log=$(mktemp)
trap 'rm -f "$log"' EXIT
node --import tsx --test --test-reporter=tap --test-concurrency=1 test/**/*.test.ts | tee "$log"
grep -qx '# skipped 0' "$log"
