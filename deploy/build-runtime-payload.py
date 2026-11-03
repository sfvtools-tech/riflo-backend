#!/usr/bin/env python3
"""Create private deployment input; never include this output in build artifacts."""
import json
import importlib.util
import os
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('deploy_release', Path(__file__).with_name('deploy-release.py'))
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)
REQUIRED = contract.REQUIRED_CONFIG
PREFIX = 'RIFLO_CONFIG_'


def payload(environment):
    supplied = {name.removeprefix(PREFIX) for name in environment if name.startswith(PREFIX)}
    if supplied - contract.CONFIG_KEYS:
        raise ValueError('Unsupported repository configuration setting')
    values = {name: environment.get(PREFIX + name, '') for name in sorted(contract.CONFIG_KEYS)}
    missing = sorted(name for name in REQUIRED if not values.get(name, '').strip())
    if missing:
        raise ValueError('Missing repository settings: ' + ', '.join(missing))
    for name, value in values.items():
        if len(value.encode('utf-8')) > 16384 or any(c in value for c in '\x00\r\n'):
            raise ValueError('Invalid repository setting: ' + name)
    result = json.dumps({'version': 1, 'values': values}, ensure_ascii=False, separators=(',', ':')) + '\n'
    if len(result.encode('utf-8')) > 128 * 1024:
        raise ValueError('Configuration exceeds size limit')
    return result


if __name__ == '__main__':
    try:
        sys.stdout.write(payload(os.environ))
    except ValueError as error:
        sys.exit(str(error))
