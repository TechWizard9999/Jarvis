#!/usr/bin/env python3
"""Idempotent host setup; never reads or prints a credential."""
import argparse
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--install-docker', action='store_true')
parser.add_argument('--clone', action='store_true')
parser.add_argument('--value')
parser.add_argument('--default', default='')
args = parser.parse_args()
def settings():
    values = {}
    env_file = root / '.env'
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                values[key] = value.strip().strip('"').strip("'")
    values.update(os.environ)
    return values
if args.value:
    allowed = {'BUGFIX_PORT', 'BUGFIX_STATE_DIR', 'BUGFIX_NETWORK'}
    if args.value not in allowed:
        raise SystemExit('Only non-secret launcher settings are readable')
    print(settings().get(args.value, args.default))
    raise SystemExit(0)

for directory in ['state', 'repos', '.secrets']:
    (root / directory).mkdir(exist_ok=True)
os.chmod(root / '.secrets', 0o700)
for name in ['nvidia_api_key', 'github_token']:
    secret = root / '.secrets' / name
    if not secret.exists():
        secret.touch(mode=0o600)

docker = shutil.which('docker')
if not docker and args.install_docker:
    if platform.system() == 'Darwin' and shutil.which('brew'):
        subprocess.run(['brew', 'install', '--cask', 'docker'], check=True)
        docker = shutil.which('docker')
    else:
        raise SystemExit('Install Docker using the official instructions: https://docs.docker.com/get-started/get-docker/')

env_path = root / '.env'
if not env_path.exists():
    content = (root / '.env.example').read_text()
    for key, value in {'BUGFIX_PROJECT_DIR': str(root), 'BUGFIX_REPO_ROOT': str(root / 'repos'), 'BUGFIX_STATE_DIR': str(root / 'state')}.items():
        content = '\n'.join(key + '=' + value if line.startswith(key + '=') else line for line in content.split('\n'))
    if docker:
        try:
            context = subprocess.check_output([docker, 'context', 'show'], text=True).strip()
            data = json.loads(subprocess.check_output([docker, 'context', 'inspect', context], text=True))[0]
            endpoint = data['Endpoints']['docker']['Host']
            if endpoint.startswith('unix://'):
                content = content.replace('DOCKER_SOCKET=/var/run/docker.sock', 'DOCKER_SOCKET=' + endpoint[7:])
        except (subprocess.CalledProcessError, KeyError, ValueError):
            pass
    env_path.write_text(content)
    os.chmod(env_path, 0o600)
    print('Created .env. Set your existing OpenCode model, fork and commit identity.')
else:
    print('Existing .env preserved.')

print('Put the NVIDIA API key in .secrets/nvidia_api_key and the publishing token in .secrets/github_token.')
print('Keep the files private (chmod 600). Never paste credentials into chat.')
if args.clone:
    values = settings()
    profile_name = values.get('BUGFIX_PROFILE_NAME', 'rtk')
    if not profile_name.replace('-', '').isalnum():
        raise SystemExit('Invalid profile name')
    profile = json.loads((root / 'profiles' / (profile_name + '.json')).read_text())
    upstream = profile['upstream']
    import re
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', upstream):
        raise SystemExit('Invalid profile upstream')
    destination = pathlib.Path(values.get('BUGFIX_REPO_ROOT', str(root / 'repos'))) / upstream.split('/')[1]
    if destination.exists():
        print(str(destination) + ' already exists; preserved.')
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['git', 'clone', '--branch', profile['baseBranch'], '--single-branch', 'https://github.com/' + upstream + '.git', str(destination)], check=True)
if docker:
    check = subprocess.run([docker, 'info', '--format', '{{.ServerVersion}}'], capture_output=True, text=True)
    print('Docker engine: ' + (check.stdout.strip() if check.returncode == 0 else 'not reachable; start Docker Desktop and retry'))
else:
    print('Docker CLI is missing. Run ./bugfix setup --install-docker or install Docker Desktop.')
print('Next: ./bugfix build, ./bugfix up, ./bugfix doctor')
