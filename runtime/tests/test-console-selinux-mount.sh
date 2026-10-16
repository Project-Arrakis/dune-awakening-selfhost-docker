#!/usr/bin/env bash
# Validate the actual Compose mount contract and a denied entrypoint write.
# Docker Compose config does not contact the daemon or relabel host files.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

python3 - "$repo_root" "$fixture" <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys

repo, fixture = map(Path, sys.argv[1:])
env = dict(os.environ)
env.pop('DUNE_HOST_REPO_ROOT', None)
custom = fixture / 'shared project'
custom.mkdir()
for host_root in (None, str(custom)):
    if host_root is not None:
        env['DUNE_HOST_REPO_ROOT'] = host_root
    result = subprocess.run([
        'docker', 'compose', '--project-directory', str(fixture),
        '--env-file', '/dev/null', '-f', str(repo / 'docker-compose.web.yml'),
        'config', '--format', 'json',
    ], env=env, capture_output=True, text=True, check=True)
    service = json.loads(result.stdout)['services']['redblink-dune-docker-console']
    mounts = {mount['target']: mount for mount in service['volumes']}
    project = mounts['/repo']
    assert project['type'] == 'bind'
    assert project['source'] == (host_root or str(fixture)), project
    assert not project.get('read_only', False)
    assert project['bind']['selinux'] == 'z', project
    # Relabel only the project, never the host Docker socket or timezone.
    for target in ('/var/run/docker.sock', '/etc/localtime'):
        assert not mounts[target].get('bind', {}).get('selinux'), target
    assert mounts['/etc/localtime']['read_only']
print('PASS: default and custom project paths use shared SELinux labeling')
PY

mkdir -p "$fixture/bin"
cat >"$fixture/bin/touch" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = /repo/.dune-write-test ]; then
  echo 'touch: /repo/.dune-write-test: Permission denied' >&2
  exit 1
fi
exec /usr/bin/touch "$@"
SH
chmod +x "$fixture/bin/touch"

if PATH="$fixture/bin:$PATH" HOME="$fixture/home" DOCKER_CONFIG="$fixture/home/.docker" \
  bash "$repo_root/console/api/entrypoint.sh" true >"$fixture/entrypoint.log" 2>&1; then
  echo 'FAIL: Console ignored the denied project write' >&2
  exit 1
fi
grep -Fq '/repo is not writable' "$fixture/entrypoint.log"
grep -Fq 'SELinux' "$fixture/entrypoint.log"
grep -Fq 'shared :z bind mount' "$fixture/entrypoint.log"
if grep -Eq 'owned by a different UID|chown -R' "$fixture/entrypoint.log"; then
  echo 'FAIL: Console assumes an ownership mismatch or recommends recursive chown' >&2
  exit 1
fi
echo 'PASS: denied writes fail clearly without assuming an ownership mismatch'
