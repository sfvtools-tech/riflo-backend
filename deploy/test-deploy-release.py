#!/usr/bin/env python3
"""Exercise the privileged extractor without root or touching application state."""
import importlib.util
import io
import json
import hashlib
import fcntl
from pathlib import Path
import tarfile
import tempfile
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('deploy_release', Path(__file__).with_name('deploy-release.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def archive(extra=()):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as tar:
        for name in ['RELEASE', 'package.json', 'package-lock.json', 'dist/server.js', 'dist/worker.js']:
            info = tarfile.TarInfo(name)
            info.size = 2
            info.mode = 0o6777
            tar.addfile(info, io.BytesIO(b'{}'))
        modules = tarfile.TarInfo('node_modules')
        modules.type = tarfile.DIRTYPE
        tar.addfile(modules)
        for entry in extra:
            tar.addfile(entry)
    buffer.seek(0)
    return tarfile.open(fileobj=buffer)


with archive() as tar, tempfile.TemporaryDirectory() as directory:
    deploy.extract(tar, deploy.validated_members(tar), Path(directory))
    assert (Path(directory) / 'dist/server.js').read_text() == '{}'
    assert (Path(directory) / 'dist/server.js').stat().st_mode & 0o7777 == 0o755

for name, kind, link in [
    ('../escape', tarfile.REGTYPE, ''),
    ('/absolute', tarfile.REGTYPE, ''),
    ('runtime.env', tarfile.REGTYPE, ''),
    ('RELEASE', tarfile.REGTYPE, ''),
    ('node_modules/fifo', tarfile.FIFOTYPE, ''),
    ('node_modules/hardlink', tarfile.LNKTYPE, 'RELEASE'),
    ('node_modules/link', tarfile.SYMTYPE, '/etc/shadow'),
    ('node_modules/link', tarfile.SYMTYPE, '../../escape'),
    ('dist', tarfile.SYMTYPE, 'node_modules'),
]:
    entry = tarfile.TarInfo(name)
    entry.type, entry.linkname = kind, link
    with archive([entry]) as tar:
        try:
            deploy.validated_members(tar)
        except ValueError:
            pass
        else:
            raise AssertionError('Accepted unsafe archive: ' + name)

entry = tarfile.TarInfo('node_modules/.bin/tool')
entry.type, entry.linkname = tarfile.SYMTYPE, '../tool/bin.js'
with archive([entry]) as tar:
    assert deploy.validated_members(tar)
print('Release extraction: valid archive and npm symlink accepted; traversal, special files, hardlinks, duplicate and unsafe links rejected.')

values = {key: 'configured' if key in deploy.REQUIRED_CONFIG else '' for key in deploy.CONFIG_KEYS}
encoded = lambda data: io.BytesIO((json.dumps(data) + '\n').encode())
assert deploy.read_config(encoded({'version': 1, 'values': values})) == values
for invalid in [
    {'version': True, 'values': values}, {'version': 2, 'values': values},
    {'version': 1, 'values': {key: value for key, value in values.items() if key != 'TRIAL_ABUSE_HMAC_KEY'}},
    {'version': 1, 'values': {}}, {'version': 1, 'values': {**values, 'NODE_OPTIONS': '--import=evil'}},
    {'version': 1, 'values': {**values, 'ANTHROPIC_API_KEY': 'secret\nINJECTION=yes'}},
    {'version': 1, 'values': {**values, 'ANTHROPIC_API_KEY': None}},
    {'version': 1, 'values': {**values, 'ANTHROPIC_API_KEY': 'x' * 16385}},
]:
    try:
        deploy.read_config(encoded(invalid))
    except ValueError:
        pass
    else:
        raise AssertionError('Accepted invalid configuration')
try:
    deploy.read_config(io.BytesIO(b'{"version":1,"version":1,"values":{}}\n'))
except ValueError:
    pass
else:
    raise AssertionError('Accepted duplicate JSON keys')

special = '  secret "quotes" \\ slash $dollar `tick` # hash = equal नमस्ते  '
text = deploy.environment_text('PORT=4310\nFFMPEG_PATH=/usr/bin/ffmpeg\nANTHROPIC_API_KEY=old\n', {'ANTHROPIC_API_KEY': special})
assert text.startswith('PORT=4310\nFFMPEG_PATH=/usr/bin/ffmpeg\n')
assert 'old' not in text and '\\"quotes\\"' in text and '\\\\ slash' in text
for existing in ['NODE_ENV=production\nnot an assignment\n', 'ANTHROPIC_API_KEY="old\\\ncontinued"\n', 'TRIAL_ABUSE_HMAC_KEY=existing\n']:
    try:
        deploy.environment_text(existing, {})
    except ValueError:
        pass
    else:
        raise AssertionError('Accepted unsupported existing config or missing managed setting')
assert deploy.environment_text('GOOGLE_DRIVE_CLIENT_ID=old\n', {'GOOGLE_DRIVE_CLIENT_ID': ''}) == '\n'
for key, value in [('TRIAL_ABUSE_HMAC_KEY', 'a' * 64), ('DRIVE_TOKEN_ENCRYPTION_KEY', 'a' * 43 + '=')]:
    for old in [value, '"' + value + '"', "'" + value + "'"]:
        assert value in deploy.environment_text(f'{key}={old}\n', {key: value})
        for replacement in ['', 'b' * len(value)]:
            try:
                deploy.environment_text(f'{key}={old}\n', {key: replacement})
            except ValueError as error:
                assert value not in str(error)
            else:
                raise AssertionError('Protected key was changed or removed')

# A missing active-code validator fails before the activator or any service command.
with tempfile.TemporaryDirectory() as directory, patch.object(deploy.subprocess, 'run') as run:
    try:
        deploy.validate_config(Path(directory), Path(directory) / 'runtime.env')
    except ValueError:
        pass
    else:
        raise AssertionError('Accepted release without configuration validator')
    run.assert_not_called()
print('Configuration checks passed: strict contract, protected host fields, explicit app settings, and pre-stop compatibility.')

# Exercise the real entrypoint and filesystem lock without services or root privileges.
release = 'a' * 40 + '-123-1'
bundle = io.BytesIO()
with tarfile.open(fileobj=bundle, mode='w:gz') as tar:
    for name in ['RELEASE', 'package.json', 'package-lock.json', 'dist/server.js', 'dist/worker.js']:
        content = (release if name == 'RELEASE' else '{}').encode()
        entry = tarfile.TarInfo(name)
        entry.size = len(content)
        tar.addfile(entry, io.BytesIO(content))
    entry = tarfile.TarInfo('node_modules')
    entry.type = tarfile.DIRTYPE
    tar.addfile(entry)
artifact = bundle.getvalue()
checksum = hashlib.sha256(artifact).hexdigest()
header = encoded({'version': 1, 'values': values}).getvalue()
original_lstat = Path.lstat

def root_stat(path):
    result = original_lstat(path)
    return SimpleNamespace(st_uid=0, st_mode=result.st_mode)

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory).resolve()
    (root / 'releases').mkdir()
    with patch.object(deploy, 'ROOT', root), patch.object(deploy.os, 'geteuid', return_value=0), patch.object(Path, 'lstat', root_stat), patch.object(deploy, 'activate') as activate:
        def invoke(args, data):
            with patch.object(deploy.sys, 'argv', ['helper', *args]), patch.object(deploy.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(data))):
                deploy.main()

        invoke([release, checksum], header + artifact)
        assert activate.call_count == 1
        invoke([release, checksum], header + artifact)
        assert activate.call_count == 2  # An identical artifact can resume after failed activation.
        (root / 'current').symlink_to(root / 'releases' / release)
        invoke(['--config'], header)
        assert activate.call_args.args[0] == root / 'releases' / release
        assert activate.call_count == 3
        for args, data in [(['--config'], b'{"version":1,"values":{}}\n'), (['--config'], header + b'extra'), ([release, '0' * 64], header + artifact)]:
            try:
                invoke(args, data)
            except ValueError:
                pass
            else:
                raise AssertionError('Invalid deployment reached activation')
        assert activate.call_count == 3
        with (root / '.deploy.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                invoke(['--config'], header)
            except BlockingIOError:
                pass
            else:
                raise AssertionError('Concurrent deployment lock was bypassed')
        assert activate.call_count == 3
print('Entrypoint checks passed: artifact retry, current-code configuration, invalid-input safety, and shared lock.')
