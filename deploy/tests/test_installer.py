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

    def test_force_target_files_always_take_target(self):
        # These files were proven (twice, on two different files) to carry
        # server-side intermediate versions with no valid git common
        # ancestor -- a 3-way merge either spuriously conflicts or, worse,
        # "succeeds" while silently dropping real content, because the
        # diverging lines don't happen to textually collide. For these
        # paths, prepare_source must always return target regardless of
        # whatever unrelated content the server currently has.
        for name in installer.FORCE_TARGET_FILES:
            with tempfile.TemporaryDirectory() as temp:
                result = installer.prepare_source(
                    name, 'completely unrelated server content\nwith multiple lines\n',
                    {'base': 'some old base', 'target': 'the correct new content'}, Path(temp),
                )
            self.assertEqual(result, 'the correct new content')

    def test_force_target_files_when_absent_on_server(self):
        for name in installer.FORCE_TARGET_FILES:
            with tempfile.TemporaryDirectory() as temp:
                result = installer.prepare_source(name, None, {'base': None, 'target': 'new'}, Path(temp))
            self.assertEqual(result, 'new')

    def test_existing_required_file_missing_still_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(RuntimeError):
                installer.prepare_source('src/app/dashboard-api/chat-manager/[...path]/route.ts', None,
                    {'base': 'original', 'target': 'updated'}, Path(temp))

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
