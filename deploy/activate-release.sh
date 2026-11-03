#!/usr/bin/env bash
# Code and runtime settings switch together after both services finish draining.
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
root=/opt/riflo
runtime=/etc/riflo/runtime.env
[[ ( $# == 1 || $# == 2 || ( $# == 3 && $3 == --current-only ) ) && $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo 'Usage: activate-release.sh RELEASE_ID [VALIDATED_ENV [--current-only]]' >&2; exit 1; }
candidate=${2:-}
exec 9>"$root/.release.lock"
flock -n 9 || { echo 'Another release operation is running.' >&2; exit 1; }
validate() {
  [[ $1 == "$root/releases/"* && ${1#"$root/releases/"} =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] &&
    [[ -d $1 && ! -L $1 && $(realpath -e "$1") == "$1" ]] &&
    [[ $(cat "$1/RELEASE") == "${1##*/}" && -f $1/dist/server.js && -f $1/dist/worker.js && -d $1/node_modules ]]
}
target="$root/releases/$1"
validate "$target" || { echo 'Invalid release directory or contents.' >&2; exit 1; }
old=''
if [[ -L $root/current ]]; then
  old=$(readlink "$root/current")
  validate "$old" || { echo 'Current release target is unsafe or incomplete.' >&2; exit 1; }
elif [[ -e $root/current ]]; then
  echo 'Current must be a symlink.' >&2; exit 1
fi
if [[ ${3:-} == --current-only && $old != "$target" ]]; then
  echo 'Active release changed during configuration validation; retry against the current release.' >&2; exit 1
fi
[[ ! -e $root/previous || -L $root/previous ]] || { echo 'Previous must be a symlink.' >&2; exit 1; }
[[ $old != "$target" || -n $candidate ]] || { echo 'Requested release is already current.'; exit 0; }
# Fail before stopping either service, including rollback to an older release.
# Use this activator's probes with the target's caption implementation.
checks=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/cloud" && pwd)
runuser -u riflo -- python3 "$checks/check-caption-fonts.py"
runuser -u riflo -- node "$checks/check-caption-render.mjs" "$target"
stage=$(mktemp -d "$root/.activate.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
if [[ -n $candidate ]]; then
  [[ $candidate == /etc/riflo/.config-*/runtime.env && -f $candidate && ! -L $candidate && $(stat -c '%u:%a' "$candidate") == 0:600 ]] || { echo 'Invalid staged environment.' >&2; exit 1; }
  cp -p -- "$runtime" "$stage/previous.env"
  install -o root -g riflo -m0640 "$stage/previous.env" "$runtime.previous"
fi
link() {
  rm -f -- "$stage/link"
  ln -s -- "$1" "$stage/link"
  mv -Tf -- "$stage/link" "$root/$2"
}
healthy() {
  local attempt
  for attempt in {1..15}; do
    if systemctl is-active --quiet riflo@server && systemctl is-active --quiet riflo@worker && curl --fail --silent --max-time 2 http://127.0.0.1:4310/health >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
replace_environment() {
  install -o root -g riflo -m0640 "$1" "$runtime.next"
  mv -Tf -- "$runtime.next" "$runtime"
}
recover() {
  trap - ERR HUP INT TERM
  echo 'Activation failed; restoring previous application and settings.' >&2
  if ! systemctl stop riflo@worker riflo@server; then
    echo 'Could not stop services. Current target retained; operator recovery required.' >&2; exit 1
  fi
  if [[ -n $candidate ]] && ! replace_environment "$stage/previous.env"; then
    echo 'Could not restore previous settings; services remain stopped.' >&2; exit 1
  fi
  if [[ -n $old ]]; then
    link "$old" current
    if ! systemctl start riflo@server riflo@worker || ! healthy; then
      echo 'Previous target restored, but service recovery failed; operator recovery required.' >&2
    fi
  else
    rm -f -- "$root/current"
    echo 'No previous release; services remain stopped.' >&2
  fi
  exit 1
}
# Existing systemd TimeoutStopSec bounds draining before any file switch.
trap recover ERR HUP INT TERM
systemctl stop riflo@worker riflo@server
if [[ -n $old && $old != "$target" ]]; then link "$old" previous; fi
if [[ -n $candidate ]]; then replace_environment "$candidate"; fi
link "$target" current
if ! systemctl start riflo@server riflo@worker || ! healthy; then recover; fi
trap - ERR HUP INT TERM
printf 'Active release: %s\n' "$target"
