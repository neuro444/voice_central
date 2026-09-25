#!/usr/bin/env python3
"""Read-only ElevenLabs -> Voice Central checks. No installs or restarts.
Authenticated GETs may create normal dashboard audit entries. No customer data
or secrets are printed. Uses only Python's standard library.
"""
import argparse
import base64
from contextlib import closing
import hashlib
import hmac
import json
from pathlib import Path
import re
import shlex
import sqlite3
import subprocess
import time
from urllib.error import HTTPError
from urllib.request import build_opener, HTTPRedirectHandler, Request

ROUTES = {'orders/recent': 'orders', 'handoffs/recent': 'handoffs', 'cost/calls': 'calls', 'callers': 'callers'}

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def fetch(url, headers=None):
    try:
        with build_opener(NoRedirect).open(Request(url, headers=headers or {}), timeout=15) as response:
            body = response.read()
            status = response.status
    except HTTPError as error:
        return error.code, None
    try:
        return status, json.loads(body)
    except (ValueError, UnicodeError):
        return status, None

def values(path):
    result = {}
    if path.exists():
        for line in path.read_text().splitlines():
            match = re.match(r'^\s*(?:export\s+)?(\w+)\s*=\s*(.*)$', line)
            if match:
                raw = match[2].strip()
                result[match[1]] = shlex.split(raw)[0] if raw.startswith(('"', "'")) else raw.split(' #', 1)[0].rstrip()
    return result

def session(secret, username):
    def b64(data):
        return base64.urlsafe_b64encode(data).decode().rstrip('=')
    payload = b64(json.dumps({'sub': username, 'exp': int(time.time()) + 300}).encode())
    return payload + '.' + b64(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())

def check(backend, dashboard, public, key, token, history_key=None):
    failures = 0
    def probe(label, url, headers=None, expected=200, field=None):
        nonlocal failures
        try:
            status, body = fetch(url, headers)
            good = status == expected and (field is None or isinstance(body, dict) and isinstance(body.get(field), list))
            detail = f'HTTP {status}'
            if good and field:
                detail += f'; {len(body[field])} records' + (' (empty feed)' if not body[field] else '')
            if status == expected and field and not good:
                detail += '; invalid response schema'
        except Exception as error:
            good, detail = False, type(error).__name__
        failures += not good
        print(f'{"PASS" if good else "FAIL"}: {label}: {detail}')
    probe('ElevenLabs health', backend + '/health')
    probe('Dashboard login', dashboard + '/login')
    probe('Dashboard rejects missing session', dashboard + '/dashboard-api/elevenlabs-agent/orders/recent', expected=401)
    for route, field in ROUTES.items():
        probe('Backend ' + route, backend + '/' + route, {'X-API-Key': key}, field=field)
        probe('Dashboard ' + route, dashboard + '/dashboard-api/elevenlabs-agent/' + route, {'Cookie': 'dash_session=' + token}, field=field)
    if public:
        probe('Public ElevenLabs health', public + '/elevenlabs-agent/health')
        probe('Public dashboard login', public + '/login')
        for route, field in ROUTES.items():
            probe('Public dashboard ' + route, public + '/dashboard-api/elevenlabs-agent/' + route, {'Cookie': 'dash_session=' + token}, field=field)
    if history_key:
        for label, base, headers in [
            ('Backend history', backend, {'X-API-Key': history_key}),
            ('Dashboard history', dashboard + '/dashboard-api/elevenlabs-agent', {'Cookie': 'dash_session=' + token}),
            *([('Public history', public + '/dashboard-api/elevenlabs-agent', {'Cookie': 'dash_session=' + token})] if public else []),
        ]:
            probe(label, base + '/elevenlabs/saved?page_size=1', headers, field='conversations')
            try:
                status, page = fetch(base + '/elevenlabs/saved?page_size=1', headers)
                rows = page.get('conversations', []) if isinstance(page, dict) else []
                if status == 200 and rows:
                    call_id = rows[0].get('conversation_id', '')
                    if not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', call_id):
                        raise ValueError('Invalid conversation ID')
                    probe(label + ' transcript', base + '/elevenlabs/conversations/' + call_id, headers, field='transcript')
                elif status == 200:
                    print('SKIP: ' + label + ' transcript: no saved calls to select')
            except Exception:
                failures += 1
                print('FAIL: ' + label + ' transcript selection')
    print(f'Checks finished: {failures} failed.')
    print('Empty feeds do not prove call ingestion. This checks API access, not browser rendering, webhook delivery, or physical printing.')
    return int(failures > 0)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dashboard-url', help='Override detected local dashboard URL')
    parser.add_argument('--public-url', default='https://cakeworld.neuroheart.ai', help='Use an empty string to skip public checks')
    args = parser.parse_args()
    def setting(name):
        return subprocess.check_output(['systemctl', 'show', 'restaurant-dashboard', '-p', name, '--value'], text=True).strip()
    root = Path(setting('WorkingDirectory'))
    if not root.is_absolute() or not root.is_dir() or setting('ActiveState') != 'active':
        raise RuntimeError('Dashboard service is not active or its directory is unavailable')
    env = {}
    for name in ('.env', '.env.production', '.env.local', '.env.production.local', '.env.elevenlabs'):
        env.update(values(root / name))
    runtime = dict(entry.decode().split('=', 1) for entry in Path('/proc/' + setting('MainPID') + '/environ').read_bytes().split(b'\0') if b'=' in entry)
    env.update(runtime)
    command = setting('ExecStart')
    port = re.search(r'(?:-p|--port)(?:=|\s+)(\d+)', command)
    if not port:
        command = json.loads((root / 'package.json').read_text()).get('scripts', {}).get('start', '')
        port = re.search(r'(?:-p|--port)(?:=|\s+)(\d+)', command)
    dashboard = args.dashboard_url or 'http://127.0.0.1:' + (port[1] if port else env.get('PORT', '3000'))
    backend = 'http://127.0.0.1:8911'
    key = values(Path('/opt/elevenlabs_agent/.env')).get('ELEVENLABS_AGENT_API_KEY')
    secret = env.get('DASHBOARD_SESSION_SECRET', '')
    if not key or len(secret) < 16:
        raise RuntimeError('Backend API key or dashboard session secret is missing')
    dbpath = Path(env.get('VOICE_CENTRAL_DB_PATH', 'data/voice_central.db'))
    if not dbpath.is_absolute():
        dbpath = root / dbpath
    with closing(sqlite3.connect(dbpath.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        row = db.execute('SELECT username FROM users ORDER BY id LIMIT 1').fetchone()
    if not row:
        raise RuntimeError('No existing staff account for authenticated checks')
    return check(backend, dashboard.rstrip('/'), args.public_url.rstrip('/'), key, session(secret, row[0]), values(Path('/opt/elevenlabs_agent/.env')).get('API_KEY'))

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print('FAIL: checker setup:', type(error).__name__)
        print('Run with sudo on the VPS; verify the active dashboard service and existing configuration. No credentials printed.')
        raise SystemExit(1)
