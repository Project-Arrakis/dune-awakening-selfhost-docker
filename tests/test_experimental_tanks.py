import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import contextlib
import io
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'runtime/scripts'))
spec = importlib.util.spec_from_file_location('tanks', ROOT / 'runtime/scripts/experimental_tanks.py')
tanks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tanks)
TAG = '2134304-0-shipping'
IMAGE = 'sha256:' + '1' * 64


class TankTests(unittest.TestCase):
    def test_manifest_assets_and_six_guards(self):
        data = tanks.manifest(TAG)
        self.assertEqual(len(data['sites']), 6)
        self.assertEqual(data['sites'][0][0], 0xdf38dc2)
        for name, expected in data['assets'].items():
            self.assertEqual(hashlib.sha256((ROOT / 'patches/experimental-tanks/2134304/assets' / name).read_bytes()).hexdigest(), expected)
        self.assertIsNone(tanks.manifest('new-build'))
        self.assertEqual(len(set(tanks.PRESETS)), 6)

    def test_default_off_and_corrupt_state_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(tanks, 'STATE', Path(directory) / 'state'):
            self.assertFalse(tanks.status(TAG)['enabled'])
            tanks.STATE.write_text('{"enabled":"true"}')
            with self.assertRaises(ValueError):
                tanks.read_state()

    def test_hagga_only_and_new_build_blocked(self):
        state = {'enabled': True, 'build': TAG, 'imageId': IMAGE}
        with patch.object(tanks, 'read_state', return_value=state), patch.object(tanks, 'run') as docker, patch.dict(tanks.os.environ, {'DUNE_GAME_SERVER_IMAGE': ''}):
            for map_name in ['Overmap', 'DeepDesert_1', 'SH_SmugglersRun', 'CB_Story_OrbitalMonitor']:
                self.assertIsNone(tanks.image_for_map(TAG, map_name))
            docker.assert_not_called()
            self.assertEqual(tanks.image_for_map(TAG, 'Survival_1'), IMAGE)
            with self.assertRaises(ValueError):
                tanks.image_for_map('new-build', 'Survival_1')
            state['imageId'] = 'sha256:bad'
            with self.assertRaises(ValueError):
                tanks.image_for_map(TAG, 'Survival_1')

    def test_binary_rejects_mismatch_and_bad_offsets(self):
        source = b'abcdef'
        expected = b'abXYef'
        fixture = {'cleanSha256': hashlib.sha256(source).hexdigest(), 'patchedSha256': hashlib.sha256(expected).hexdigest(), 'sites': [[2, '6364', '5859']]}
        self.assertEqual(tanks.patch_binary(source, fixture), expected)
        with self.assertRaises(ValueError):
            tanks.patch_binary(b'broken', fixture)
        fixture['sites'][0][0] = 1
        with self.assertRaises(ValueError):
            tanks.patch_binary(source, fixture)

    def test_base_identity_supports_both_docker_image_stores(self):
        spec = tanks.manifest(TAG)
        for image in [spec['baseImage'].split('@')[1], spec['baseConfigId']]:
            with patch.object(tanks, 'run', return_value=image):
                self.assertEqual(tanks.base_image_id(spec), image)
        with patch.object(tanks, 'run', return_value=IMAGE):
            with self.assertRaises(ValueError):
                tanks.base_image_id(spec)

    def test_atomic_setting_preserves_image_policy(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(tanks, 'STATE', Path(directory) / 'state'):
            tanks.save({'enabled': True, 'build': TAG, 'imageId': IMAGE})
            self.assertEqual(tanks.read_state()['imageId'], IMAGE)
            self.assertEqual(len(list(Path(directory).iterdir())), 1)

    def test_apply_restarts_only_running_hagga_and_preserves_saved_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            saved = root / 'runtime/game/survival-1/Saved'
            saved.mkdir(parents=True)
            (saved / 'sentinel').write_text('preserve')
            actions = []
            def command(*args, **kwargs):
                if args[0] == 'docker' and args[1] == 'ps':
                    return '\n'.join(json.dumps({'Names': name}) for name in ['dune-server-survival-1', 'dune-server-survival-1-31', 'dune-server-overmap', 'dune-server-cb-overland-s-06-26'])
                if args[0] == 'docker' and args[1] == 'inspect':
                    return IMAGE
                return ''
            def sietch(args, **kwargs):
                actions.append(args[1:])
            def query(sql):
                return '1\t0\n31\t1\n40\t2\n' if 'order by' in sql else '1'
            with patch.object(tanks, 'ROOT', root), patch.object(tanks, 'STATE', root / 'runtime/generated/experimental-tanks.json'), patch.object(tanks, 'build', return_value=IMAGE), patch.object(tanks, 'run', side_effect=command), patch.object(tanks, 'query_tsv', side_effect=query), patch.object(tanks.subprocess, 'run', side_effect=sietch), patch.object(tanks, 'hagga_is_ready', side_effect=[False, True, True]) as readiness, patch.object(tanks.time, 'sleep'):
                tanks.apply(TAG, True)
                self.assertEqual(actions, [['stop-partition', '1'], ['stop-partition', '31'], ['start-partition', '1'], ['start-partition', '31']])
                self.assertTrue(tanks.read_state()['enabled'])
                self.assertFalse(tanks.read_state()['applying'])
                self.assertEqual(readiness.call_count, 3)
                self.assertEqual((saved / 'sentinel').read_text(), 'preserve')
                self.assertEqual(len(list((root / 'runtime/backups/experimental-tanks').glob('*/dune-server-survival-1/Saved/sentinel'))), 1)
                cli = (ROOT / 'runtime/scripts/sietches.sh').read_text()
                for action, _ in actions:
                    self.assertIn(f'  {action})', cli)

    def test_apply_readiness_uses_the_same_contract_as_maps(self):
        for name, partition, required in [('dune-server-survival-1', 1, '3'), ('dune-server-survival-1-31', 31, '0')]:
            for exit_code in (0, 1):
                with patch.object(tanks.subprocess, 'run', return_value=tanks.subprocess.CompletedProcess([], exit_code)) as execute:
                    self.assertEqual(tanks.hagga_is_ready(partition, name), exit_code == 0)
                    self.assertEqual(execute.call_args.args[0][-3:], [name, str(partition), required])
                    self.assertIn('farm_partition_is_ready', execute.call_args.args[0][2])

    def test_catalog_off_and_six_presets_on(self):
        catalog = str(ROOT / 'runtime/data/admin-vehicles.json')
        for enabled in (False, True):
            state = {'enabled': enabled, 'build': TAG, 'imageId': IMAGE}
            with patch.object(tanks, 'read_state', return_value=state), patch.dict(tanks.os.environ, {'DUNE_WORLD_IMAGE_TAG': TAG}), patch.object(sys, 'argv', ['tanks', 'catalog', catalog]), contextlib.redirect_stdout(io.StringIO()) as output:
                tanks.main()
            rows = json.loads(output.getvalue())
            tanks_rows = [row for row in rows if row['id'] == 'Tank']
            self.assertEqual(bool(tanks_rows), enabled)
            if enabled:
                self.assertEqual(tanks_rows[0]['templates'], tanks.PRESETS)

    def test_spawn_guard_checks_ready_partition_running_image_and_scope(self):
        state = {'enabled': True, 'build': TAG, 'imageId': IMAGE}
        with patch.object(tanks, 'read_state', return_value=state), patch.dict(tanks.os.environ, {'DUNE_WORLD_IMAGE_TAG': TAG, 'DUNE_GAME_SERVER_IMAGE': ''}), patch.object(tanks, 'query_tsv', return_value='1'), patch.object(tanks, 'run', return_value=IMAGE + ' true'):
            with patch.object(sys, 'argv', ['tanks', 'guard', 'Survival_1', 'dune-server-survival-1', '1', 'ServerId']):
                tanks.main()
            with patch.object(sys, 'argv', ['tanks', 'guard', 'Overmap', 'dune-server-overmap', '2', 'ServerId']):
                with self.assertRaises(ValueError):
                    tanks.main()
            with patch.object(sys, 'argv', ['tanks', 'guard', 'Survival_1', 'dune-server-survival-1', '1', 'ServerId']), patch.object(tanks, 'run', return_value=IMAGE + ' false'):
                with self.assertRaises(ValueError):
                    tanks.main()


if __name__ == '__main__':
    unittest.main()
