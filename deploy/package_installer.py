#!/usr/bin/env python3
"""Package only the dashboard integration sources; never environment files."""
import ast
import base64
import json
from pathlib import Path
import subprocess

DEPLOY = Path(__file__).resolve().parent
ROOT = DEPLOY.parent
FILES = (
    'src/app/DashboardClient.tsx',
    'src/app/DashboardScreen.tsx',
    'src/app/dashboard-api/chat-manager/[...path]/route.ts',
    'src/app/dashboard-api/telephony/[...path]/route.ts',
    'src/app/dashboard-api/elevenlabs-agent/[...path]/route.ts',
    'src/lib/audit.ts',
    'src/lib/elevenlabs-history.ts',
)

def build():
    payload = {}
    for name in FILES:
        result = subprocess.run(['git', 'show', 'HEAD:' + name], cwd=ROOT, capture_output=True, text=True)
        if result.returncode and name not in ('src/app/dashboard-api/elevenlabs-agent/[...path]/route.ts', 'src/lib/elevenlabs-history.ts'):
            raise RuntimeError('Missing baseline: ' + name)
        payload[name] = {'base': result.stdout if result.returncode == 0 else None,
                         'target': (ROOT / name).read_text()}
    encoded = base64.b64encode(json.dumps(payload).encode()).decode()
    template = (DEPLOY / 'installer_template.py').read_text()
    assert template.count('__PAYLOAD__') == 1
    output = template.replace('__PAYLOAD__', encoded)
    ast.parse(output)
    destination = DEPLOY / 'dist/setup_voice_central_elevenlabs_server.py'
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(output)
    destination.chmod(0o700)
    return destination

if __name__ == '__main__':
    print(build())
