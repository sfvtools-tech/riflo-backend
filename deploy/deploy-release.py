#!/usr/bin/python3
"""Root-owned deployment entry point. Archive bytes arrive on stdin, never a root-opened user path."""
import fcntl
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path('/opt/riflo')
ACTIVATOR = '/usr/local/lib/riflo-deploy/activate-release.sh'
MAX_ARCHIVE = 512 * 1024 * 1024
MAX_UNPACKED = 2 * 1024 * 1024 * 1024


def validated_members(archive):
    members = []
    seen = {}
    total = 0
    for member in archive:
        members.append(member)
        if len(members) > 100_000:
            raise ValueError('Release exceeds archive entry limit')
        path = PurePosixPath(member.name)
        if (path.is_absolute() or '..' in path.parts or not path.parts
                or path.parts[0] not in {'dist', 'node_modules', 'package.json', 'package-lock.json', 'RELEASE'}
                or str(path) in seen or not (member.isfile() or member.isdir() or member.issym())):
            raise ValueError('Unsafe archive entry: ' + member.name)
        seen[str(path)] = member
        total += member.size
        if total > MAX_UNPACKED:
            raise ValueError('Release exceeds unpacked size limit')
        if member.issym():
            target = PurePosixPath(member.linkname)
            parts = list(path.parent.parts)
            if target.is_absolute():
                raise ValueError('Absolute symlink')
            for part in target.parts:
                if part == '..':
                    if not parts:
                        raise ValueError('Escaping symlink')
                    parts.pop()
                elif part != '.':
                    parts.append(part)
    for name in seen:
        for ancestor in PurePosixPath(name).parents:
            if str(ancestor) in seen and not seen[str(ancestor)].isdir():
                raise ValueError('Archive entry has non-directory parent')
    for name in ['RELEASE', 'package.json', 'package-lock.json', 'dist/server.js', 'dist/worker.js']:
        if name not in seen or not seen[name].isfile():
            raise ValueError('Missing required release file: ' + name)
    if 'node_modules' not in seen or not seen['node_modules'].isdir():
        raise ValueError('Missing dependencies')
    return members


def extract(archive, members, destination):
    # Explicit extraction excludes device nodes, hardlinks, owners and setuid bits.
    for member in members:
        target = destination / member.name
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        if member.isdir():
            target.mkdir(exist_ok=True, mode=0o755)
        elif member.issym():
            target.symlink_to(member.linkname)
        else:
            with archive.extractfile(member) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 3:
        raise ValueError('Usage (root): riflo-deploy-release RELEASE SHA256 < archive.tar.gz')
    release, expected = sys.argv[1:]
    if not re.fullmatch(r'[0-9a-f]{40}-[0-9]+-[0-9]+', release) or not re.fullmatch(r'[0-9a-f]{64}', expected):
        raise ValueError('Invalid release identity or checksum')
    for directory in [ROOT, ROOT / 'releases']:
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Deployment directories must be root-owned and not writable by others')
    os.umask(0o022)
    with (ROOT / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        target = ROOT / 'releases' / release
        if target.exists() or target.is_symlink():
            raise ValueError('Release already exists; use a new run attempt')
        with tempfile.TemporaryDirectory(prefix='.deploy-', dir=ROOT) as directory:
            stage = Path(directory)
            archive_path = stage / 'release.tar.gz'
            digest = hashlib.sha256()
            size = 0
            with archive_path.open('xb') as output:
                while chunk := sys.stdin.buffer.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_ARCHIVE:
                        raise ValueError('Archive exceeds size limit')
                    digest.update(chunk)
                    output.write(chunk)
            if digest.hexdigest() != expected:
                raise ValueError('Archive checksum mismatch')
            unpacked = stage / 'release'
            unpacked.mkdir(mode=0o755)
            with tarfile.open(archive_path, 'r:gz') as archive:
                members = validated_members(archive)
                extract(archive, members, unpacked)
            for member in members:
                if member.issym():
                    (unpacked / member.name).resolve().relative_to(unpacked.resolve())
            if (unpacked / 'RELEASE').read_text().strip() != release:
                raise ValueError('Release identity mismatch')
            unpacked.rename(target)
        subprocess.run(['/bin/bash', ACTIVATOR, release], check=True)


if __name__ == '__main__':
    main()
