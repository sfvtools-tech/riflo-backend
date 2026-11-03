#!/usr/bin/python3
"""Root-owned deployment entry point. Archive bytes arrive on stdin, never a root-opened user path."""
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
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
RUNTIME = Path('/etc/riflo/runtime.env')
MAX_CONFIG = 128 * 1024
REQUIRED_CONFIG = {
    'ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY', 'FIREBASE_PROJECT_ID',
    'FIREBASE_STORAGE_BUCKET', 'CORS_ALLOWED_ORIGINS', 'TRIAL_ENABLED', 'RETENTION_ENABLED',
    'ANTHROPIC_TEXT_MODEL', 'ANTHROPIC_VIDEO_MODEL', 'ANTHROPIC_NEWSLETTER_MODEL',
    'DEEPGRAM_MODEL', 'DEEPGRAM_LANGUAGE', 'GENERATION_MAX_OUTPUT_TOKENS',
    'GENERATION_LONG_FORM_MAX_OUTPUT_TOKENS', 'GENERATION_STAGE_TIMEOUT_MS',
}
CONFIG_KEYS = REQUIRED_CONFIG | {
    'ANTHROPIC_TEXT_MODEL', 'ANTHROPIC_VIDEO_MODEL', 'ANTHROPIC_NEWSLETTER_MODEL',
    'DEEPGRAM_MODEL', 'DEEPGRAM_LANGUAGE', 'GENERATION_MAX_OUTPUT_TOKENS',
    'GENERATION_LONG_FORM_MAX_OUTPUT_TOKENS', 'GENERATION_STAGE_TIMEOUT_MS',
    'GOOGLE_DRIVE_CLIENT_ID', 'GOOGLE_DRIVE_CLIENT_SECRET', 'GOOGLE_DRIVE_REDIRECT_URI',
    'DRIVE_TOKEN_ENCRYPTION_KEY', 'TRIAL_ABUSE_HMAC_KEY', 'DEEPGRAM_MICROS_PER_MINUTE',
    'RIFLO_MEDIA_MAX_DIMENSION', 'RIFLO_MEDIA_MAX_PIXELS', 'RIFLO_MEDIA_MAX_FPS',
    'RIFLO_MEDIA_MAX_STREAMS', 'SOURCE_VALIDATION_MAX_ACTIVE', 'SOURCE_VALIDATION_MAX_PER_ACCOUNT',
    'STREAM_MAX_MILLISECONDS', 'STREAM_MAX_ACTIVE', 'STREAM_MAX_PER_ACCOUNT', 'RIFLO_WORKER_TRACE',
} | {
    prefix + suffix
    for prefix in ['ANTHROPIC_', 'ANTHROPIC_VIDEO_', 'ANTHROPIC_NEWSLETTER_']
    for suffix in ['INPUT_MICROS_PER_MILLION', 'OUTPUT_MICROS_PER_MILLION',
                   'CACHE_READ_MICROS_PER_MILLION', 'CACHE_WRITE_MICROS_PER_MILLION']
}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate configuration key')
        result[key] = value
    return result


def read_config(stream):
    line = stream.readline(MAX_CONFIG + 1)
    if len(line) > MAX_CONFIG or not line.endswith(b'\n'):
        raise ValueError('Configuration must be one bounded JSON line')
    try:
        payload = json.loads(line, object_pairs_hook=unique_object)
    except (ValueError, UnicodeError):
        raise ValueError('Invalid configuration JSON') from None
    if not isinstance(payload, dict) or set(payload) != {'version', 'values'} or type(payload['version']) is not int or payload['version'] != 1:
        raise ValueError('Unsupported configuration contract')
    values = payload['values']
    if not isinstance(values, dict) or set(values) != CONFIG_KEYS:
        raise ValueError('Configuration must contain every supported key and no others')
    for value in values.values():
        try:
            valid = isinstance(value, str) and len(value.encode('utf-8')) <= 16384 and not any(character in value for character in '\0\r\n')
        except UnicodeError:
            valid = False
        if not valid:
            raise ValueError('Configuration values must be bounded single-line strings')
    if any(not values.get(key, '').strip() for key in REQUIRED_CONFIG):
        raise ValueError('Required production configuration is missing')
    return values


def environment_text(existing, values):
    lines = []
    for line in existing.rstrip('\n').split('\n'):
        if not line.strip() or line.lstrip().startswith(('#', ';')):
            lines.append(line)
            continue
        match = re.match(r'^\s*([A-Z][A-Z0-9_]*)=', line)
        if not match or line.endswith('\\'):
            raise ValueError('Existing environment needs single-line assignments')
        try:
            parsed = shlex.split(line[match.end():], comments=False)
        except ValueError:
            raise ValueError('Existing environment needs complete single-line assignments') from None
        if match[1] in {'DRIVE_TOKEN_ENCRYPTION_KEY', 'TRIAL_ABUSE_HMAC_KEY'}:
            if len(parsed) != 1 or not re.fullmatch(r'[A-Za-z0-9+/=]+', parsed[0]):
                raise ValueError('Existing protected key needs operator verification: ' + match[1])
            if values.get(match[1]) != parsed[0]:
                raise ValueError('Protected key changes require a separate operator rotation: ' + match[1])
        if match[1] not in CONFIG_KEYS:
            lines.append(line)
    # systemd does not expand variables in EnvironmentFile; quote only its escapes.
    for key, value in sorted(values.items()):
        if value:
            escaped = value.replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$')
            lines.append(f'{key}="{escaped}"')
    return '\n'.join(lines) + '\n'


def validate_config(target, candidate):
    validator = target / 'dist/validate-production-config.js'
    if not validator.is_file() or validator.is_symlink():
        raise ValueError('Deploy code with configuration validation before applying configuration')
    result = subprocess.run([
        '/usr/bin/systemd-run', '--wait', '--pipe', '--quiet', '--collect',
        '--property=User=riflo', '--property=Group=riflo',
        '--property=Environment=NODE_ENV=production', f'--property=EnvironmentFile={candidate}',
        '--property=RuntimeMaxSec=30', '--property=NoNewPrivileges=yes',
        '--property=ProtectSystem=strict', '--property=ProtectHome=yes', '--property=PrivateTmp=yes',
        '/usr/bin/node', str(validator),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45)
    if result.returncode:
        raise ValueError('Production configuration validation failed; live services were not changed')


def activate(target, values, current_only=False):
    info = RUNTIME.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o027:
        raise ValueError('Runtime environment must be a protected root-owned file')
    with tempfile.TemporaryDirectory(prefix='.config-', dir=RUNTIME.parent) as directory:
        candidate = Path(directory) / 'runtime.env'
        candidate.write_text(environment_text(RUNTIME.read_text(), values), encoding='utf-8')
        candidate.chmod(0o600)
        validate_config(target, candidate)
        command = ['/bin/bash', ACTIVATOR, target.name, str(candidate)]
        if current_only:
            command.append('--current-only')
        subprocess.run(command, check=True)


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
    config_only = sys.argv[1:] == ['--config']
    if os.geteuid() != 0 or (not config_only and len(sys.argv) != 3):
        raise ValueError('Usage (root): riflo-deploy-release RELEASE SHA256 | --config')
    if not config_only:
        release, expected = sys.argv[1:]
        if not re.fullmatch(r'[0-9a-f]{40}-[0-9]+-[0-9]+', release) or not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise ValueError('Invalid release identity or checksum')
    values = read_config(sys.stdin.buffer)
    for directory in [ROOT, ROOT / 'releases']:
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Deployment directories must be root-owned and not writable by others')
    os.umask(0o022)
    with (ROOT / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if config_only:
            if sys.stdin.buffer.read(1):
                raise ValueError('Unexpected content after configuration')
            current = ROOT / 'current'
            target = current.resolve(strict=True)
            if not current.is_symlink() or target.parent != ROOT / 'releases' or target.is_symlink():
                raise ValueError('Current release is invalid')
            activate(target, values, current_only=True)
            return
        target = ROOT / 'releases' / release
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
            if target.exists() or target.is_symlink():
                checksum = target / '.archive-sha256'
                if target.is_symlink() or not checksum.is_file() or checksum.read_text().strip() != expected:
                    raise ValueError('Existing release does not match this artifact')
                activate(target, values)
                return
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
            (unpacked / '.archive-sha256').write_text(expected + '\n')
            unpacked.rename(target)
        activate(target, values)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        # Only our validation messages are safe to show; OS/process errors may include input.
        print(str(error) if isinstance(error, ValueError) else 'Deployment failed; check service health and operator logs.', file=sys.stderr)
        sys.exit(1)
