#!/usr/bin/env python3
"""Trusted dependency preparation. Build/test operations execute offline, without secrets."""
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

def run(argv):
    print('+ ' + ' '.join(argv), flush=True)
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    executed = 0
    for line in process.stdout:
        print(line, end='', flush=True)
        match = re.search(r'test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;', line)
        if match:
            executed += int(match[1]) + int(match[2])
    if process.wait() != 0:
        raise subprocess.CalledProcessError(process.returncode, argv)
    if argv[:2] == ['cargo', 'test'] and executed == 0:
        raise RuntimeError('Baseline Cargo suite executed no tests; zero matches cannot establish readiness')

mode = sys.argv[1]
if mode == 'fetch':
    # Fetch cannot execute Cargo build scripts. Isolate Cargo configuration from host credentials.
    os.environ.pop('CARGO_NET_OFFLINE', None)
    run(['cargo', 'fetch', '--locked'])
    for name in ['registry', 'git']:
        source = pathlib.Path('/opt/cargo') / name
        if source.exists():
            shutil.copytree(source, pathlib.Path('/seed') / name, dirs_exist_ok=True)
elif mode == 'baseline':
    checks = json.loads(sys.argv[2])
    for argv in checks.values():
        run(argv)
elif mode == 'invalidate-workspace':
    data = json.loads(subprocess.check_output(['cargo', 'metadata', '--format-version', '1', '--no-deps', '--locked', '--offline']))
    members = set(data['workspace_members'])
    for package in data['packages']:
        if package['id'] in members:
            run(['cargo', 'clean', '-p', package['name'], '--locked', '--offline'])
else:
    raise SystemExit('Unknown preparation operation')
