#!/usr/bin/env python3
"""Exercise the privileged extractor without root or touching application state."""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile

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
