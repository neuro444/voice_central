import ast
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parents[1]

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded

installer = module('installer', DEPLOY / 'installer_template.py')
packager = module('packager', DEPLOY / 'package_installer.py')

class InstallerTests(unittest.TestCase):
    def test_env_preserves_other_settings(self):
        original = '# configuration\nPLIVO_KEY=keep\nexport ELEVENLABS_AGENT_API_KEY=old\nOTHER="a b"\n'
        result = installer.update_env(original, {'ELEVENLABS_AGENT_API_KEY': 'new'})
        self.assertIn('PLIVO_KEY=keep\n', result)
        self.assertIn('OTHER="a b"\n', result)
        self.assertEqual(installer.env_values(result)['ELEVENLABS_AGENT_API_KEY'], 'new')
        self.assertEqual(result.count('ELEVENLABS_AGENT_API_KEY'), 1)

    def test_invalid_env_rejected(self):
        with self.assertRaises(RuntimeError):
            installer.update_env('', {'KEY': 'value\ninjected=yes'})

    def test_merge_preserves_server_change(self):
        base = ''.join(f'line {i}\n' for i in range(20))
        current = base.replace('line 1\n', 'server edit\n')
        target = base.replace('line 18\n', 'integration edit\n')
        with tempfile.TemporaryDirectory() as temp:
            result = installer.merge_source('some/other/file.ts', current, base, target, Path(temp))
        self.assertIn('server edit', result)
        self.assertIn('integration edit', result)

    def test_merge_conflict_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(RuntimeError):
                installer.merge_source('some/other/file.ts', 'server\n', 'base\n', 'local\n', Path(temp))

    def test_new_route_and_rerun(self):
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(installer.merge_source('some/other/file.ts', None, None, 'new', Path(temp)), 'new')
            self.assertEqual(installer.merge_source('some/other/file.ts', 'new', None, 'new', Path(temp)), 'new')
            with self.assertRaises(RuntimeError):
                installer.merge_source('some/other/file.ts', 'existing', None, 'new', Path(temp))

    def test_known_intermediate_server_state_reconciled(self):
        # A prior installer run deployed the 401->502 auth-loop fix for this
        # route directly to the server without committing that intermediate
        # version, so git has no common ancestor to 3-way-merge against the
        # later version that also adds the history routes. This is the
        # actual real-world incident this reconciliation was built for.
        name = 'src/app/dashboard-api/elevenlabs-agent/[...path]/route.ts'
        current = installer.KNOWN_INTERMEDIATE_SERVER_STATE[name]
        target = current.replace(
            '  const apiKey = process.env.ELEVENLABS_AGENT_API_KEY;',
            '  const apiKey = path.startsWith("elevenlabs/")\n'
            '    ? process.env.ELEVENLABS_CONVERSATIONS_API_KEY\n'
            '    : process.env.ELEVENLABS_AGENT_API_KEY;',
        ).replace(
            '  /^callers$/,\n',
            '  /^callers$/,\n  /^elevenlabs\\/saved$/,\n',
        )
        with tempfile.TemporaryDirectory() as temp:
            result = installer.merge_source(name, current, 'unrelated-base', target, Path(temp))
        self.assertEqual(result, target)

    def test_known_intermediate_server_state_does_not_misfire(self):
        # If the server's file is even slightly different from the exact
        # known intermediate snapshot, this must NOT silently take target --
        # it should fall through to the normal merge/conflict path.
        name = 'src/app/dashboard-api/elevenlabs-agent/[...path]/route.ts'
        current = installer.KNOWN_INTERMEDIATE_SERVER_STATE[name] + '\n// unexpected extra line'
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(RuntimeError):
                installer.merge_source(name, current, None, 'target', Path(temp))

    def test_committed_new_route_absent_on_server(self):
        name = 'src/app/dashboard-api/elevenlabs-agent/[...path]/route.ts'
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(installer.prepare_source(name, None,
                {'base': 'committed route', 'target': 'updated route'}, Path(temp)), 'updated route')

    def test_existing_required_file_missing_still_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(RuntimeError):
                installer.prepare_source('src/app/DashboardScreen.tsx', None,
                    {'base': 'original', 'target': 'updated'}, Path(temp))

    def test_existing_new_route_conflict_still_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(RuntimeError):
                installer.prepare_source('src/app/dashboard-api/elevenlabs-agent/[...path]/route.ts',
                    'server edit\n', {'base': 'original\n', 'target': 'local edit\n'}, Path(temp))

    def test_bundle_is_exact_source_allowlist(self):
        output = packager.build()
        parsed = ast.parse(output.read_text())
        payload = next(ast.literal_eval(n.value) for n in parsed.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'PAYLOAD' for t in n.targets))
        files = json.loads(base64.b64decode(payload))
        self.assertEqual(set(files), set(packager.FILES))
        for name, versions in files.items():
            self.assertTrue(name.startswith('src/'))
            self.assertEqual(versions['target'], (packager.ROOT / name).read_text())

if __name__ == '__main__':
    unittest.main()
