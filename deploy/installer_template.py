#!/usr/bin/env python3
"""One-shot Voice Central ElevenLabs update. Run as root on the VPS.
Only restaurant-dashboard is stopped/started. No backend or nginx changes.
"""
import base64
from contextlib import closing
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import sqlite3
import subprocess
import tempfile
import time
import urllib.request

PAYLOAD = '__PAYLOAD__'
SERVICE = 'restaurant-dashboard'
ROOT = Path('/opt/voice_central')
ENV_NAMES = ('.env', '.env.production', '.env.local', '.env.production.local')


def setting(name):
    return subprocess.check_output(['systemctl', 'show', SERVICE, '-p', name, '--value'], text=True).strip()


def env_values(text):
    result = {}
    for line in text.splitlines():
        match = re.match(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$', line)
        if match:
            value = match[2].strip()
            if value.startswith(('"', "'")):
                value = shlex.split(value)[0] if value else ''
            else:
                value = value.split(' #', 1)[0].rstrip()
            result[match[1]] = value
    return result


def update_env(text, updates):
    lines = [line for line in text.splitlines() if not any(
        re.match(r'^\s*(?:export\s+)?' + re.escape(key) + r'\s*=', line) for key in updates)]
    for key, value in updates.items():
        if any(c in value for c in '\r\n\x00'):
            raise RuntimeError('Unsupported newline in integration configuration')
        lines.append(key + '=' + json.dumps(value))
    return '\n'.join(lines) + '\n'


def request(url, headers=None, json_body=True):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=10) as response:
        if response.status != 200 or response.geturl() != url:
            raise RuntimeError('Unexpected HTTP response')
        return json.load(response) if json_body else response.read()


def merge_source(name, current, base, target, scratch):
    if current == target or current == base:
        return target
    if base is None:
        raise RuntimeError('New route already exists with different contents; refusing overwrite')
    paths = [scratch / n for n in ('current', 'base', 'target')]
    for path, value in zip(paths, (current, base, target)):
        path.write_text(value)
    result = subprocess.run(['git', 'merge-file', '-p', *map(str, paths)], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Server/local source conflict; live files remain unchanged')
    return result.stdout


# Files this integration owns outright: the server has been proven (twice,
# on two different files) to carry an out-of-band intermediate version that
# was never committed, for which git has no valid common ancestor. A 3-way
# merge against such a `base` either raises a spurious conflict or -- worse
# -- succeeds "cleanly" while silently dropping real content, because the
# diverging lines don't happen to textually collide. There is no legitimate
# reason for the server to hold independent unmerged edits to these
# specific files that aren't already in this repo's git history, so for
# these paths this installer always takes `target` outright and never
# attempts a merge.
FORCE_TARGET_FILES = {
    'src/app/dashboard-api/elevenlabs-agent/[...path]/route.ts',
    'src/lib/elevenlabs-history.ts',
    'src/app/DashboardClient.tsx',
    'src/app/DashboardScreen.tsx',
    'src/lib/audit.ts',
}


def prepare_source(name, current, versions, scratch):
    if name in FORCE_TARGET_FILES:
        return versions['target']
    if current is None:
        if versions['base'] is not None:
            raise RuntimeError('Expected existing source file is missing: ' + name)
        return versions['target']
    return merge_source(name, current, versions['base'], versions['target'], scratch)


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run with sudo python3.')
    lock = open('/run/lock/voice-central-elevenlabs-deploy.lock', 'w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if Path(setting('WorkingDirectory')).resolve() != ROOT or not ROOT.is_dir():
        raise SystemExit('Unexpected dashboard WorkingDirectory; refusing changes.')
    if setting('ActiveState') != 'active':
        raise SystemExit('Dashboard is not active; investigate before updating.')
    user = setting('User') or 'root'
    account = pwd.getpwnam(user)
    pid = int(setting('MainPID'))
    runtime = dict(entry.decode().split('=', 1) for entry in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in entry)
    effective = {}
    for name in ENV_NAMES:
        path = ROOT / name
        if path.exists():
            effective.update(env_values(path.read_text()))
    effective.update(runtime)
    command = setting('ExecStart')
    if not re.search(r'(?:-p|--port)(?:=|\s+)\d+', command):
        command += ' ' + json.loads((ROOT / 'package.json').read_text()).get('scripts', {}).get('start', '')
    port_match = re.search(r'(?:-p|--port)(?:=|\s+)(\d+)', command)
    port = int(port_match[1] if port_match else effective.get('PORT', '3000'))
    local = f'http://127.0.0.1:{port}'
    request(local + '/login', json_body=False)
    backend_env = env_values(Path('/opt/elevenlabs_agent/.env').read_text())
    key = backend_env.get('ELEVENLABS_AGENT_API_KEY', '')
    if not key:
        raise SystemExit('ElevenLabs backend dashboard key is missing; no changes made.')
    history_key = backend_env.get('API_KEY', '')
    if not history_key:
        raise SystemExit('Backend conversation API_KEY missing; no changes made.')
    updates = {'ELEVENLABS_CONVERSATIONS_API_KEY': history_key, 'ELEVENLABS_AGENT_INTERNAL_URL': 'http://127.0.0.1:8911', 'ELEVENLABS_AGENT_API_KEY': key}
    for route in ('orders/recent', 'handoffs/recent'):
        data = request(updates['ELEVENLABS_AGENT_INTERNAL_URL'] + '/' + route, {'X-API-Key': key})
        field = route.split('/')[0]
        if not isinstance(data.get(field), list):
            raise RuntimeError('Unexpected ElevenLabs response schema')
    history = request(updates['ELEVENLABS_AGENT_INTERNAL_URL'] + '/elevenlabs/saved?page_size=1', {'X-API-Key': history_key})
    if not isinstance(history.get('conversations'), list):
        raise RuntimeError('Unexpected saved history response')
    secret = effective.get('DASHBOARD_SESSION_SECRET', '')
    if len(secret) < 16:
        raise SystemExit('Cannot verify dashboard session configuration; no changes made.')
    db_path = Path(effective.get('VOICE_CENTRAL_DB_PATH', str(ROOT / 'data/voice_central.db')))
    if not db_path.is_absolute():
        db_path = ROOT / db_path
    with closing(sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True)) as db:
        row = db.execute('SELECT username FROM users ORDER BY id LIMIT 1').fetchone()
    if not row:
        raise SystemExit('No existing staff account for authenticated verification.')
    node = shutil.which('node', path=runtime.get('PATH'))
    npm = shutil.which('npm', path=runtime.get('PATH'))
    if not node or not npm:
        raise SystemExit('Node/npm missing from service PATH.')
    subprocess.run([node, '-e', 'require("node:sqlite")'], check=True, capture_output=True)
    if shutil.disk_usage(ROOT).free < 2 * 1024**3:
        raise SystemExit('Need at least 2 GiB free for staged npm install/build.')
    bundle = json.loads(base64.b64decode(PAYLOAD))
    backup = Path('/opt/voice_central_backups') / ('elevenlabs-' + str(time.time_ns()))
    backup.mkdir(parents=True, mode=0o700)
    stage = Path(tempfile.mkdtemp(prefix='.elevenlabs-build-', dir=ROOT.parent))
    stage.chmod(0o755)
    dropin = Path('/etc/systemd/system/restaurant-dashboard.service.d/90-elevenlabs.conf')
    changed = list(bundle) + ['.env', '.env.production.local', '.env.elevenlabs']
    originals = {}
    ownership = {}
    source_snapshot = {}
    moved = []
    promoted = []
    stopped = False
    try:
        print('Preflight passed. Preparing build; dashboard remains running.', flush=True)
        for name in ('src', 'public'):
            shutil.copytree(ROOT / name, stage / name, symlinks=False)
        for name in ('package.json', 'package-lock.json', 'next.config.js', 'tsconfig.json', 'next-env.d.ts', '.eslintrc.json', *ENV_NAMES):
            if (ROOT / name).exists():
                shutil.copy2(ROOT / name, stage / name)
        with tempfile.TemporaryDirectory() as temp:
            for name, versions in bundle.items():
                path = ROOT / name
                current = path.read_text() if path.exists() else None
                source_snapshot[name] = current
                if path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != ROOT.parent):
                    raise RuntimeError('Symlink in changed source path; refusing overwrite')
                merged = prepare_source(name, current, versions, Path(temp))
                (stage / name).parent.mkdir(parents=True, exist_ok=True)
                (stage / name).write_text(merged)
        for name in ('.env', '.env.production.local'):
            path = stage / name
            path.write_text(update_env(path.read_text() if path.exists() else '', updates))
            path.chmod(0o600)
        (stage / '.env.elevenlabs').write_text(update_env('', updates))
        (stage / '.env.elevenlabs').chmod(0o600)
        subprocess.run(['chown', '-R', f'{account.pw_uid}:{account.pw_gid}', str(stage)], check=True)
        build_env = {**os.environ, **effective, **updates, 'PATH': runtime.get('PATH', os.environ['PATH']),
                     'HOME': account.pw_dir, 'NEXT_TELEMETRY_DISABLED': '1',
                     'VOICE_CENTRAL_DB_PATH': str(stage / 'build-data.db'),
                     'AUDIT_LOG_PATH': str(stage / 'build-audit.jsonl')}
        # Logs can contain application details; keep them in the root-only backup.
        with (backup / 'build.log').open('w') as log:
            for command in ([npm, 'ci', '--include=dev', '--no-audit', '--no-fund'], [npm, 'run', 'build']):
                print('Running ' + ' '.join(command[1:]) + ' in staging.', flush=True)
                result = subprocess.run(command, cwd=stage, env=build_env, stdout=log, stderr=subprocess.STDOUT,
                    user=account.pw_uid, group=account.pw_gid, extra_groups=[], timeout=1800)
                if result.returncode:
                    raise RuntimeError('Staged build failed; see private build.log in backup')
        for name, previous in source_snapshot.items():
            path = ROOT / name
            if (path.read_text() if path.exists() else None) != previous:
                raise RuntimeError('Source changed during build; rerun deployment')
        for name in ('.env', '.env.production.local'):
            path = ROOT / name
            (stage / name).write_text(update_env(path.read_text() if path.exists() else '', updates))
        # Snapshot runtime data through SQLite's backup API, not a live file copy.
        with closing(sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True)) as db, closing(sqlite3.connect(backup / 'users.db')) as copy:
            db.backup(copy)
        for path in [ROOT / name for name in changed] + [dropin]:
            if path.is_symlink():
                raise RuntimeError('Symlink in configuration path; refusing overwrite')
            if path.exists():
                ownership[str(path)] = (path.stat().st_uid, path.stat().st_gid)
            originals[str(path)] = path.read_bytes() if path.exists() else None
            if path.exists():
                target = backup / 'files' / str(path).lstrip('/')
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
        (backup / 'manifest.json').write_text(json.dumps({'files': {p: v is not None for p,v in originals.items()}, 'service': SERVICE}, indent=2))
        print('Build passed. Switching dashboard files.', flush=True)
        stopped = True
        subprocess.run(['systemctl', 'stop', SERVICE], check=True, timeout=60)
        for name in ('.next', 'node_modules'):
            if (ROOT / name).exists():
                (ROOT / name).rename(backup / name)
                moved.append(name)
            (stage / name).rename(ROOT / name)
            promoted.append(name)
        for name in changed:
            (ROOT / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(stage / name, ROOT / name)
            os.chown(ROOT / name, account.pw_uid, account.pw_gid)
        dropin.parent.mkdir(parents=True, exist_ok=True)
        dropin.write_text('[Service]\nEnvironmentFile=/opt/voice_central/.env.elevenlabs\n')
        subprocess.run(['systemctl', 'daemon-reload'], check=True, timeout=60)
        subprocess.run(['systemctl', 'start', SERVICE], check=True, timeout=60)
        def b64(value):
            return base64.urlsafe_b64encode(value).decode().rstrip('=')
        payload = b64(json.dumps({'sub': row[0], 'exp': int(time.time()) + 120}).encode())
        token = payload + '.' + b64(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())
        for attempt in range(20):
            try:
                request(local + '/login', json_body=False)
                for route, field in (('orders/recent','orders'), ('handoffs/recent','handoffs'), ('elevenlabs/saved?page_size=1', 'conversations')):
                    data = request(local + '/dashboard-api/elevenlabs-agent/' + route, {'Cookie': 'dash_session=' + token})
                    if not isinstance(data.get(field), list):
                        raise RuntimeError('Unexpected proxy response')
                break
            except Exception:
                if attempt == 19:
                    raise RuntimeError('Dashboard login/authenticated proxy verification failed') from None
                time.sleep(1)
        print('SUCCESS: dashboard login and authenticated ElevenLabs orders/handoffs proxy verified.')
        print('Backup:', backup)
        print('Refresh Voice Central. No other service or nginx configuration was changed.')
    except BaseException:
        if stopped:
            subprocess.run(['systemctl', 'stop', SERVICE], check=True, timeout=60)
            for path, data in originals.items():
                path = Path(path)
                saved = backup / 'files' / str(path).lstrip('/')
                if data is None:
                    path.unlink(missing_ok=True)
                else:
                    shutil.copy2(saved, path)
                    os.chown(path, *ownership[str(path)])
            for name in promoted:
                shutil.rmtree(ROOT / name)
            for name in moved:
                (backup / name).rename(ROOT / name)
            subprocess.run(['systemctl', 'daemon-reload'], check=True, timeout=60)
            subprocess.run(['systemctl', 'start', SERVICE], check=True, timeout=60)
            for attempt in range(20):
                try:
                    request(local + '/login', json_body=False)
                    break
                except Exception:
                    if attempt == 19:
                        raise RuntimeError('Rollback restored files but login verification failed') from None
                    time.sleep(1)
            print('Original dashboard restored and login verified.')
        else:
            print('No live dashboard changes were made.')
        print('Private logs/backup:', backup)
        raise
    finally:
        shutil.rmtree(stage, ignore_errors=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('FAILED:', type(error).__name__, str(error) if isinstance(error, RuntimeError) else 'See private logs; no secrets printed.')
        raise SystemExit(1)
