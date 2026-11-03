#!/usr/bin/env python3
"""Linux integration check using dummy values and the real systemd parser."""
import base64
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location('deploy_release', Path(__file__).with_name('deploy-release.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

if os.geteuid() != 0 or not Path('/run/systemd/system').is_dir():
    raise SystemExit('Run this check as root on a systemd Linux host.')

value = ' spaces "quotes" \\ slash $dollar `ticks` #hash =equals नमस्ते 中文 \u2028 unicode '
with tempfile.TemporaryDirectory(prefix='riflo-config-check-') as directory:
    candidate = Path(directory) / 'environment'
    candidate.write_text(deploy.environment_text('', {'ROUNDTRIP_VALUE': value}), encoding='utf-8')
    candidate.chmod(0o600)
    # systemd reads the private file before dropping privileges to an unrelated user.
    subprocess.run([
        'systemd-run', '--wait', '--pipe', '--quiet', '--collect',
        '--property=User=nobody', f'--property=EnvironmentFile={candidate}',
        '/usr/bin/python3', '-c',
        'import os,sys,base64; assert os.environ["ROUNDTRIP_VALUE"] == base64.b64decode(sys.argv[1]).decode()',
        base64.b64encode(value.encode()).decode(),
    ], check=True, timeout=30)
print('Native systemd environment roundtrip passed.')
