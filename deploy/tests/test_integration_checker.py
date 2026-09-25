import base64
from contextlib import redirect_stdout
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
from pathlib import Path
import threading
import unittest

path = Path(__file__).resolve().parents[1] / 'check_elevenlabs_integrations.py'
spec = importlib.util.spec_from_file_location('checker', path)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)

class CheckerTests(unittest.TestCase):
    def run_flow(self, fault=None, history=False):
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                seen.append(self.path)
                proxy = self.path.startswith('/dashboard-api/')
                status, body = 200, {'ok': True}
                if proxy and not self.headers.get('Cookie'):
                    status = 401
                elif proxy and fault == 'upstream_auth':
                    status = 502
                elif proxy and fault == 'redirect':
                    self.send_response(302)
                    self.send_header('Location', '/login')
                    self.end_headers()
                    return
                else:
                    for route, field in checker.ROUTES.items():
                        if self.path.endswith('/' + route):
                            if not proxy and self.headers.get('X-API-Key') != 'fake-key':
                                status = 403
                            body = {field: []} if fault != 'schema' else {'wrong': []}
                if '/elevenlabs/saved?' in self.path and status == 200:
                    body = {'conversations': [{'conversation_id': 'conv_test'}]}
                if '/elevenlabs/conversations/' in self.path and status == 200:
                    body = {'transcript': [{'role': 'user', 'message': 'private test text'}]}
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        output = io.StringIO()
        try:
            url = f'http://127.0.0.1:{server.server_port}'
            with redirect_stdout(output):
                code = checker.check(url, url, url, 'fake-key', 'fake-session', 'fake-history-key' if history else None)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        self.assertNotIn('fake-key', output.getvalue())
        self.assertNotIn('fake-session', output.getvalue())
        return code, output.getvalue(), seen

    def test_history_and_transcript_flow(self):
        code, output, seen = self.run_flow(history=True)
        self.assertEqual(code, 0)
        self.assertIn('Public history transcript', output)
        self.assertNotIn('private test text', output)
        self.assertNotIn('fake-history-key', output)

    def test_full_flow_empty_feeds(self):
        code, output, seen = self.run_flow()
        self.assertEqual(code, 0)
        self.assertEqual(len(seen), 17)
        self.assertIn('empty feed', output)

    def test_backend_auth_failure_is_detected(self):
        code, output, _ = self.run_flow('upstream_auth')
        self.assertEqual(code, 1)
        self.assertIn('HTTP 502', output)

    def test_redirect_does_not_pass_as_login_success(self):
        code, output, _ = self.run_flow('redirect')
        self.assertEqual(code, 1)
        self.assertIn('HTTP 302', output)

    def test_bad_schema_fails(self):
        code, output, _ = self.run_flow('schema')
        self.assertEqual(code, 1)
        self.assertIn('invalid response schema', output)

    def test_signed_session_matches_dashboard_contract(self):
        token = checker.session('test-secret-long-enough', 'test-staff')
        payload, signature = token.split('.')
        decoded = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        self.assertEqual(decoded['sub'], 'test-staff')
        expected = base64.urlsafe_b64encode(hmac.new(b'test-secret-long-enough', payload.encode(), hashlib.sha256).digest()).decode().rstrip('=')
        self.assertEqual(signature, expected)

if __name__ == '__main__':
    unittest.main()
