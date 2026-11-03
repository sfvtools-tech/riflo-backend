#!/usr/bin/env bash
# Isolated command-stub checks; never invokes real services or changes /opt.
set -euo pipefail
stage=$(mktemp -d)
stage=$(cd "$stage" && pwd -P)
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/cloud" "$stage/bin" "$stage/root/releases" "$stage/etc/.config-test"
export TEST_ROOT="$stage/root" TEST_LOG="$stage/log"
sed -e "s|root=/opt/riflo|root=$TEST_ROOT|" -e "s|/etc/riflo|$stage/etc|g" -e 's/\[\[ $EUID == 0 \]\]/true/' "$(dirname "$0")/activate-release.sh" > "$stage/activate.sh"
cat > "$stage/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TEST_LOG"
if [[ $(readlink "$TEST_ROOT/current") == "$TEST_ROOT/releases/new" ]]; then
  [[ ${FAIL_START:-} != yes || $1 != start ]] || exit 1
  # Real systemctl with multiple units succeeds when ANY unit is active.
  [[ ${FAIL_WORKER:-} != yes || "$*" != 'is-active --quiet riflo@worker' ]] || exit 1
fi
STUB
cat > "$stage/bin/runuser" <<'STUB'
#!/usr/bin/env bash
if [[ ${FAIL_FONTS:-} == yes && $4 == python3 ]]; then exit 1; fi
if [[ ${FAIL_RASTER:-} == yes && $4 == node ]]; then exit 1; fi
exit 0
STUB
cat > "$stage/bin/curl" <<'STUB'
#!/usr/bin/env bash
[[ ${FAIL_HEALTH:-} != yes || $(readlink "$TEST_ROOT/current") != "$TEST_ROOT/releases/new" ]]
STUB
cat > "$stage/bin/flock" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
# macOS mv lacks -T; model GNU atomic replacement for the isolated fixture.
cat > "$stage/bin/mv" <<'STUB'
#!/usr/bin/env python3
import os, sys
marker = os.environ['TEST_ROOT'] + '/rename-failed'
if os.environ.get('FAIL_RENAME') == 'yes' and os.path.basename(sys.argv[-1]) == os.environ.get('RENAME_DEST', 'previous') and not os.path.exists(marker):
    open(marker, 'w').close()
    sys.exit(1)
os.replace(sys.argv[-2], sys.argv[-1])
STUB
cat > "$stage/bin/realpath" <<'STUB'
#!/usr/bin/env python3
import os, sys
print(os.path.realpath(sys.argv[-1]))
STUB
cat > "$stage/bin/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$stage/bin/stat" <<'STUB'
#!/usr/bin/env bash
printf '0:600\n'
STUB
cat > "$stage/bin/install" <<'STUB'
#!/usr/bin/env python3
import shutil, sys
shutil.copyfile(sys.argv[-2], sys.argv[-1])
STUB
chmod +x "$stage/bin/"*
export PATH="$stage/bin:$PATH"
for release in old new; do
  mkdir -p "$TEST_ROOT/releases/$release/dist" "$TEST_ROOT/releases/$release/node_modules"
  touch "$TEST_ROOT/releases/$release/dist/server.js" "$TEST_ROOT/releases/$release/dist/worker.js"
  printf '%s\n' "$release" > "$TEST_ROOT/releases/$release/RELEASE"
done
ln -s "$TEST_ROOT/releases/old" "$TEST_ROOT/current"
reject() { if bash "$stage/activate.sh" "$1" >/dev/null 2>&1; then echo "Unexpected acceptance: $1" >&2; exit 1; fi; }
reject ../old
reject 'new;echo bad'
reject missing
ln -s "$TEST_ROOT/releases/new" "$TEST_ROOT/releases/alias"
reject alias
[[ ! -e $TEST_LOG ]]
for failure in FAIL_FONTS FAIL_RASTER; do
  env "$failure=yes" bash "$stage/activate.sh" new >/dev/null 2>&1 && exit 1
  [[ ! -e $TEST_LOG ]]
  [[ $(readlink "$TEST_ROOT/current") == "$TEST_ROOT/releases/old" ]]
done
FAIL_START=yes bash "$stage/activate.sh" new >/dev/null 2>&1 && exit 1
[[ $(readlink "$TEST_ROOT/current") == "$TEST_ROOT/releases/old" ]]
[[ $(tail -n 1 "$TEST_LOG") == 'is-active --quiet riflo@worker' ]]
FAIL_HEALTH=yes bash "$stage/activate.sh" new >/dev/null 2>&1 && exit 1
[[ $(readlink "$TEST_ROOT/current") == "$TEST_ROOT/releases/old" ]]
for failure in FAIL_WORKER FAIL_RENAME; do
  env "$failure=yes" bash "$stage/activate.sh" new >/dev/null 2>&1 && exit 1
  [[ $(readlink "$TEST_ROOT/current") == "$TEST_ROOT/releases/old" ]]
  [[ $(tail -n 3 "$TEST_LOG" | head -n 1) == 'start riflo@server riflo@worker' ]]
  [[ $(tail -n 1 "$TEST_LOG") == 'is-active --quiet riflo@worker' ]]
done
rm "$TEST_ROOT/rename-failed"
FAIL_RENAME=yes RENAME_DEST=current bash "$stage/activate.sh" new >/dev/null 2>&1 && exit 1
[[ $(readlink "$TEST_ROOT/current") == "$TEST_ROOT/releases/old" ]]
[[ $(tail -n 3 "$TEST_LOG" | head -n 1) == 'start riflo@server riflo@worker' ]]
[[ $(tail -n 1 "$TEST_LOG") == 'is-active --quiet riflo@worker' ]]
bash "$stage/activate.sh" new >/dev/null
[[ $(readlink "$TEST_ROOT/current") == "$TEST_ROOT/releases/new" ]]
[[ $(readlink "$TEST_ROOT/previous") == "$TEST_ROOT/releases/old" ]]
bash "$stage/activate.sh" old >/dev/null
[[ $(readlink "$TEST_ROOT/current") == "$TEST_ROOT/releases/old" ]]
# Failed activation restores code and the exact previous environment together.
printf 'TOKEN=old\n' > "$stage/etc/runtime.env"
printf 'TOKEN=new\n' > "$stage/etc/.config-test/runtime.env"
FAIL_START=yes bash "$stage/activate.sh" new "$stage/etc/.config-test/runtime.env" >/dev/null 2>&1 && exit 1
[[ $(readlink "$TEST_ROOT/current") == "$TEST_ROOT/releases/old" ]]
[[ $(cat "$stage/etc/runtime.env") == TOKEN=old ]]
[[ $(cat "$stage/etc/runtime.env.previous") == TOKEN=old ]]
# Applying settings to the current release restarts it without changing its identity.
bash "$stage/activate.sh" old "$stage/etc/.config-test/runtime.env" >/dev/null
[[ $(readlink "$TEST_ROOT/current") == "$TEST_ROOT/releases/old" ]]
[[ $(cat "$stage/etc/runtime.env") == TOKEN=new ]]
# A rollback between config validation and activation must not reactivate old code.
count=$(wc -l < "$TEST_LOG")
if bash "$stage/activate.sh" new "$stage/etc/.config-test/runtime.env" --current-only >/dev/null 2>&1; then exit 1; fi
[[ $(readlink "$TEST_ROOT/current") == "$TEST_ROOT/releases/old" ]]
[[ $(wc -l < "$TEST_LOG") == "$count" ]]
[[ $(cat "$stage/etc/runtime.env") == TOKEN=new ]]
# Unsafe current target is rejected before any service command.
rm "$TEST_ROOT/current"
ln -s /tmp "$TEST_ROOT/current"
count=$(wc -l < "$TEST_LOG")
reject new
[[ $(wc -l < "$TEST_LOG") == "$count" ]]
rm "$TEST_ROOT/current"
FAIL_START=yes bash "$stage/activate.sh" new >/dev/null 2>&1 && exit 1
[[ ! -e $TEST_ROOT/current && ! -L $TEST_ROOT/current ]]
[[ $(tail -n 1 "$TEST_LOG") == 'stop riflo@worker riflo@server' ]]
echo 'Release activation checks passed.'
