import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import novel_tts as manager


class FakeController:
    def __init__(self, failures=None):
        self.calls = []
        self.failures = dict(failures or {})
        self.active = {manager.SERVICE: True, manager.CACHE: True}
        self.enabled = {manager.SERVICE: True, manager.CACHE: True}

    def __call__(self, *args, check=True):
        self.calls.append(args)
        remaining = self.failures.get(args[0], 0)
        if remaining:
            self.failures[args[0]] = remaining - 1
            raise RuntimeError(f'fake {args[0]} failure')
        if args[0] == 'stop':
            for name in args[1:]: self.active[name] = False
        elif args[0] == 'disable':
            for name in args[1:]: self.enabled[name] = False
        elif args[0] == 'start':
            for name in args[1:]: self.active[name] = True
        elif args[0] == 'enable':
            for name in args[1:]: self.enabled[name] = True
        output = ('active\n' if self.active.get(args[1], False) else 'inactive\n') if args[0] == 'is-active' else ('enabled\n' if self.enabled.get(args[1], False) else 'disabled\n') if args[0] == 'is-enabled' else ''
        return SimpleNamespace(stdout=output, returncode=0)


class PartialController(FakeController):
    def __init__(self, action):
        super().__init__()
        self.action = action
        self.failed = False

    def __call__(self, *args, check=True):
        if args[0] == self.action and not self.failed:
            self.calls.append(args); self.failed = True
            target = args[1]
            if self.action == 'stop': self.active[target] = False
            if self.action == 'disable': self.enabled[target] = False
            raise RuntimeError(f'fake partial {self.action} failure')
        return super().__call__(*args, check=check)


class UninstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = self.root / 'home'; self.home.mkdir()
        self.config_path = self.home / '.config/novel-local-reader/config.json'
        self.units = self.home / '.config/systemd/user'
        self.app = self.home / '.local/share/novel-local-reader'
        self.launcher = self.home / '.local/bin/novel-tts'
        self.cache = self.root / 'cache'; self.cache.mkdir()
        self.external = self.root / 'external'; self.external.mkdir()
        for name in ('model.gguf', 'codec.gguf', 'voice.spk', 'voice.rvq', 'voice.txt'):
            (self.external / name).write_text('private fixture')
        server = self.external / 'tts-server'; server.write_text('server'); server.chmod(0o755)
        self.config = {
            'schema': 3, 'backend': 'qwen3', 'mode': 'qwen', 'data_root': '', 'require_mount': False,
            'cache_dir': str(self.cache), 'cache_limit_mb': 100, 'voice': 'voice', 'token': 'x' * 40,
            'profiles': {'qwen': {'cwd': str(self.external), 'argv': [str(server), '--model', str(self.external / 'model.gguf'), '--codec', str(self.external / 'codec.gguf'), '--host', '127.0.0.1', '--port', '8080', '--lang', 'English'], 'voices': {'voice': {'spk': str(self.external / 'voice.spk'), 'rvq': str(self.external / 'voice.rvq'), 'text': str(self.external / 'voice.txt')}}}},
        }
        self.config_path.parent.mkdir(parents=True); self.config_path.write_text(json.dumps(self.config))
        (self.cache / 'keep.wav').write_text('cache')
        self.ctl = FakeController(); self.subprocess_calls = []
        def tripwire(*args, **kwargs):
            self.subprocess_calls.append((args, kwargs)); raise AssertionError('unmocked subprocess blocked')
        self.patches = [
            patch.object(manager, 'CONFIG_PATH', self.config_path), patch.object(manager, 'UNITS', self.units),
            patch.object(manager, 'APP', self.app), patch.object(manager, 'XDG_DATA_HOME', self.app.parent),
            patch.object(Path, 'home', return_value=self.home),
            patch.object(manager.subprocess, 'run', side_effect=tripwire), patch.object(manager.subprocess, 'Popen', side_effect=tripwire),
            patch.object(manager.subprocess, 'call', side_effect=tripwire), patch.object(manager.subprocess, 'check_call', side_effect=tripwire),
            patch.object(manager.subprocess, 'check_output', side_effect=tripwire),
        ]
        for item in self.patches: item.start()

    def tearDown(self):
        for item in reversed(self.patches): item.stop()
        self.tmp.cleanup()

    def install_components(self, manifest=True, override=True, custom=True):
        self.units.mkdir(parents=True, exist_ok=True); self.app.mkdir(parents=True, exist_ok=True); self.launcher.parent.mkdir(parents=True, exist_ok=True)
        for name, command in ((manager.SERVICE, 'run'), (manager.CACHE, 'cache')):
            (self.units / name).write_text(manager.unit_text(command, 'fixture'))
            drop = self.units / f'{name}.d'; drop.mkdir()
            if override: (drop / 'override.conf').write_text(manager.OWNED_OVERRIDE_TEXT)
            if custom: (drop / 'custom.conf').write_text('[Service]\nEnvironment=CUSTOM=1\n')
        for name in manager.OWNED_APP_FILES - {manager.OWNERSHIP_FILE}: (self.app / name).write_text('owned')
        if manifest: (self.app / manager.OWNERSHIP_FILE).write_text(json.dumps({'schema': 1, 'project': manager.APP_NAME, 'version': manager.VERSION, 'files': sorted(manager.OWNED_APP_FILES)}))
        (self.app / 'keep.txt').write_text('unknown')
        self.launcher.write_text('#!/bin/sh\nexec /usr/bin/python3 ' + str(self.app / 'novel_tts.py') + ' "$@"\n')

    def clock(self): return datetime(2026, 2, 3, 4, 5, 6, 7)

    def test_plan_complete_preserves_unknown_dropins_and_has_stable_contract(self):
        self.install_components()
        tree_before = sorted(str(path.relative_to(self.home)) for path in self.home.rglob('*'))
        before = {p: p.read_bytes() for p in (self.app / 'keep.txt', self.units / f'{manager.SERVICE}.d/custom.conf', self.config_path)}
        plan = manager.uninstall_plan()
        self.assertEqual(set(plan), {'planned_removals', 'removed', 'preserved', 'skipped', 'conflicts', 'snapshot_id', 'rollback_performed', 'rollback_status'})
        self.assertIn(f'{manager.SERVICE}.d/override.conf', plan['planned_removals'])
        self.assertIn(f'{manager.SERVICE}.d/custom.conf', plan['preserved']); self.assertIn('app/keep.txt', plan['preserved'])
        self.assertEqual(plan['removed'], []); self.assertIsNone(plan['snapshot_id']); self.assertFalse(plan['rollback_performed'])
        self.assertEqual(before, {p: p.read_bytes() for p in before}); self.assertEqual(self.ctl.calls, []); self.assertEqual(self.subprocess_calls, [])
        self.assertEqual(tree_before, sorted(str(path.relative_to(self.home)) for path in self.home.rglob('*')))
        self.assertEqual(json.dumps(plan, sort_keys=True), json.dumps(manager.uninstall_plan(), sort_keys=True))

    def test_plan_partial_schema_two_without_manifest_and_schema_three_manifest(self):
        self.app.mkdir(parents=True); (self.app / 'novel_tts.py').write_text('legacy')
        self.config['schema'] = 2
        self.assertEqual(manager.uninstall_plan()['planned_removals'], ['app/novel_tts.py'])
        (self.app / manager.OWNERSHIP_FILE).write_text(json.dumps({'schema': 1, 'project': manager.APP_NAME, 'version': '1.3.9', 'files': sorted(manager.OWNED_APP_FILES)}))
        self.config['schema'] = 3
        self.assertFalse(manager.uninstall_plan()['conflicts'])

    def test_schema_two_execution_preserves_configuration_byte_for_byte(self):
        self.install_components(); self.config['schema'] = 2
        original = json.dumps(self.config, indent=3).encode(); self.config_path.write_bytes(original)
        manager.execute_uninstall(self.config, ctl=self.ctl, clock=self.clock)
        self.assertEqual(self.config_path.read_bytes(), original)

    def test_ownership_manifest_is_atomic_private_minimal_and_path_safe(self):
        transaction = manager.InstallTransaction(
            self.config, ctl=self.ctl, ready=lambda _: None,
            source_dir=Path(manager.__file__).resolve().parent, clock=self.clock,
        )
        transaction.snapshot(operation='setup'); transaction.stage_files()
        manifest_path = transaction.stage / 'app' / manager.OWNERSHIP_FILE
        manifest = json.loads(manifest_path.read_text())
        self.assertEqual(manifest_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(set(manifest), {
            'schema', 'project', 'version', 'files', 'package_files_sha256', 'package_fingerprint'
        })
        self.assertEqual(set(manifest['files']), manager.OWNED_APP_FILES)
        for name in manifest['files']:
            self.assertEqual(Path(name).name, name); self.assertNotIn('..', name)
            self.assertNotIn('/', name); self.assertNotIn('\\', name)
        self.assertTrue(manifest['package_fingerprint'].isascii())
        self.assertRegex(manifest['package_fingerprint'], r'^[0-9a-f]{64}$')
        self.assertTrue(manifest['package_files_sha256'])
        for key, digest in manifest['package_files_sha256'].items():
            self.assertIn(key, manager.PACKAGE_FILES)
            self.assertRegex(digest, r'^[0-9a-f]{64}$')
        encoded = json.dumps(manifest)
        for private in (self.config['token'], self.config['cache_dir'], str(self.external), 'model.gguf', 'codec.gguf', 'voice.spk', 'voice.rvq', 'voice.txt'):
            self.assertNotIn(private, encoded)

    def test_tampered_manifest_conflicts_before_snapshot_or_controller(self):
        self.install_components()
        for unsafe in ('/tmp/outside', '../outside', 'nested/name', 'nested\\name'):
            with self.subTest(unsafe=unsafe):
                (self.app / manager.OWNERSHIP_FILE).write_text(json.dumps({
                    'schema': 1, 'project': manager.APP_NAME, 'version': manager.VERSION,
                    'files': [unsafe],
                }))
                with self.assertRaisesRegex(ValueError, 'Conflitos'):
                    manager.execute_uninstall(self.config, ctl=self.ctl, clock=self.clock)
                self.assertFalse((self.config_path.parent / 'backups').exists())
                self.assertEqual(self.ctl.calls, []); self.assertTrue((self.app / 'novel_tts.py').exists())

    def test_plan_rejects_foreign_components_manifest_and_symlinks(self):
        cases = ('unit', 'unit_duplicate', 'launcher', 'override', 'app_file', 'app_symlink', 'nested_app_symlink', 'units_root_symlink', 'launcher_symlink', 'unit_symlink', 'override_symlink', 'manifest')
        for case in cases:
            with self.subTest(case=case):
                with tempfile.TemporaryDirectory(dir=self.root) as child:
                    app = Path(child) / 'data/novel-local-reader'
                    units = Path(child) / 'config/systemd/user'
                    config_path = Path(child) / 'config/novel-local-reader/config.json'
                    launcher = Path(child) / '.local/bin/novel-tts'
                    with patch.object(manager, 'APP', app), patch.object(manager, 'XDG_DATA_HOME', app.parent), patch.object(manager, 'UNITS', units), patch.object(manager, 'CONFIG_PATH', config_path), patch.object(Path, 'home', return_value=Path(child)):
                        units.mkdir(parents=True); app.mkdir(parents=True); launcher.parent.mkdir(parents=True)
                        (units / manager.SERVICE).write_text(manager.unit_text('run', 'fixture'))
                        launcher.write_text('#!/bin/sh\nexec /usr/bin/python3 ' + str(app / 'novel_tts.py') + '\n')
                        (app / 'novel_tts.py').write_text('x')
                        drop = units / f'{manager.SERVICE}.d'; drop.mkdir(); (drop / 'override.conf').write_text(manager.OWNED_OVERRIDE_TEXT)
                        target = Path(child) / 'outside'; target.write_text('outside')
                        if case == 'unit': (units / manager.SERVICE).write_text('foreign')
                        elif case == 'unit_duplicate':
                            with (units / manager.SERVICE).open('a') as stream: stream.write('\n[Service]\nExecStart=/bin/foreign\n')
                        elif case == 'launcher': launcher.write_text('foreign')
                        elif case == 'override': (drop / 'override.conf').write_text('foreign')
                        elif case == 'app_file': shutil.rmtree(app); app.write_text('foreign')
                        elif case == 'app_symlink': shutil.rmtree(app); app.symlink_to(target)
                        elif case == 'nested_app_symlink':
                            nested = app / 'unknown'; nested.mkdir(); (nested / 'escape').symlink_to(target)
                        elif case == 'units_root_symlink': shutil.rmtree(units); units.symlink_to(target)
                        elif case == 'launcher_symlink': launcher.unlink(); launcher.symlink_to(target)
                        elif case == 'unit_symlink': (units / manager.SERVICE).unlink(); (units / manager.SERVICE).symlink_to(target)
                        elif case == 'override_symlink': (drop / 'override.conf').unlink(); (drop / 'override.conf').symlink_to(target)
                        elif case == 'manifest': (app / manager.OWNERSHIP_FILE).write_text('{"schema":1,"files":["../outside"]}')
                        self.assertTrue(manager.uninstall_plan()['conflicts'])

    def test_dangerous_path_and_json_dry_run_are_redacted(self):
        with patch.object(manager, 'APP', Path('/')):
            self.assertIn('app:dangerous_path', manager.uninstall_plan()['conflicts'])
        output = io.StringIO()
        with contextlib.redirect_stdout(output): manager.main(['uninstall', '--dry-run', '--json'], ctl=self.ctl, interactive=False)
        parsed = json.loads(output.getvalue())
        self.assertEqual(parsed['removed'], []); self.assertIsNone(parsed['snapshot_id'])
        self.assertFalse((self.config_path.parent / 'backups').exists())
        self.assertEqual(self.ctl.calls, []); self.assertEqual(self.subprocess_calls, [])
        for secret in (self.config['token'], 'Authorization', 'ref_text', 'private fixture', str(self.external)):
            self.assertNotIn(secret, output.getvalue())

    def test_execute_success_preserves_private_and_unknown_data_and_is_idempotent(self):
        self.install_components(); external_before = {p: p.read_bytes() for p in self.external.iterdir()}; config_before = self.config_path.read_bytes()
        result = manager.execute_uninstall(self.config, ctl=self.ctl, clock=self.clock)
        self.assertEqual(set(result['removed']), set(result['planned_removals'])); self.assertIsNotNone(result['snapshot_id'])
        snapshot = self.config_path.parent / 'backups' / result['snapshot_id']
        self.assertEqual(snapshot.stat().st_mode & 0o777, 0o700)
        self.assertEqual(sorted(path.name for path in (snapshot / 'quarantine').iterdir()),
                         sorted(item.replace('/', '__') for item in result['removed']))
        self.assertNotIn('keep.txt', [path.name for path in (snapshot / 'quarantine').iterdir()])
        self.assertTrue((self.app / 'keep.txt').exists()); self.assertTrue((self.units / f'{manager.SERVICE}.d/custom.conf').exists())
        self.assertTrue(self.config_path.exists()); self.assertEqual(self.config_path.read_bytes(), config_before); self.assertTrue((self.cache / 'keep.wav').exists())
        self.assertEqual(external_before, {p: p.read_bytes() for p in self.external.iterdir()})
        self.ctl.calls.clear(); second = manager.execute_uninstall(self.config, ctl=self.ctl, clock=self.clock)
        self.assertIn('nothing_to_remove', second['skipped']); self.assertIsNone(second['snapshot_id']); self.assertEqual(self.ctl.calls, [])

    def test_empty_managed_directories_are_removed_but_nonempty_parents_remain(self):
        self.install_components(custom=False)
        (self.app / 'keep.txt').unlink()
        result = manager.execute_uninstall(self.config, ctl=self.ctl, clock=self.clock)
        self.assertEqual(result['rollback_status'], 'not_started')
        self.assertFalse(self.app.exists())
        self.assertFalse((self.units / f'{manager.SERVICE}.d').exists())
        self.assertTrue(self.units.exists()); self.assertTrue(self.config_path.parent.exists())

    def test_conflict_refuses_before_snapshot_or_controller(self):
        self.units.mkdir(parents=True); (self.units / manager.SERVICE).write_text('foreign')
        with self.assertRaises(ValueError): manager.execute_uninstall(self.config, ctl=self.ctl, clock=self.clock)
        self.assertFalse((self.config_path.parent / 'backups').exists()); self.assertEqual(self.ctl.calls, [])

    def test_failures_after_snapshot_rollback_and_preserve_original_error(self):
        for action in ('stop', 'disable', 'daemon-reload'):
            with self.subTest(action=action):
                self.install_components(); ctl = FakeController({action: 1})
                with self.assertRaises(manager.TransactionFailure) as raised:
                    manager.execute_uninstall(self.config, ctl=ctl, clock=self.clock)
                self.assertTrue(raised.exception.result['rollback_performed']); self.assertEqual(raised.exception.result['rollback_status'], 'complete')
                self.assertEqual(raised.exception.result['removed'], [])
                self.assertTrue((self.app / 'novel_tts.py').exists()); self.assertTrue(self.launcher.exists())
                shutil.rmtree(self.app); shutil.rmtree(self.units); self.launcher.unlink()

    def test_partial_stop_and_disable_restore_all_service_states(self):
        for action in ('stop', 'disable'):
            with self.subTest(action=action):
                self.install_components(); ctl = PartialController(action)
                with self.assertRaises(manager.TransactionFailure) as raised:
                    manager.execute_uninstall(self.config, ctl=ctl, clock=self.clock)
                self.assertEqual(raised.exception.result['rollback_status'], 'complete')
                self.assertTrue(all(ctl.active.values())); self.assertTrue(all(ctl.enabled.values()))
                self.assertTrue(self.launcher.exists()); self.assertTrue((self.app / 'keep.txt').exists())
                shutil.rmtree(self.app); shutil.rmtree(self.units); self.launcher.unlink()

    def test_rollback_restores_original_mixed_active_and_enabled_states(self):
        self.install_components()
        self.ctl.active[manager.CACHE] = False
        self.ctl.enabled[manager.SERVICE] = False
        original_active = dict(self.ctl.active); original_enabled = dict(self.ctl.enabled)
        with self.assertRaises(manager.TransactionFailure):
            manager.execute_uninstall(
                self.config, ctl=self.ctl, clock=self.clock,
                verifier=lambda _: (_ for _ in ()).throw(ValueError('verify failure')),
            )
        self.assertEqual(self.ctl.active, original_active)
        self.assertEqual(self.ctl.enabled, original_enabled)

    def test_move_and_verify_failures_rollback(self):
        self.install_components(); real_move = shutil.move; calls = {'count': 0}
        def mover(source, target):
            calls['count'] += 1
            if calls['count'] == 2: raise OSError('quarantine failure')
            return real_move(source, target)
        with self.assertRaises(manager.TransactionFailure): manager.execute_uninstall(self.config, ctl=self.ctl, clock=self.clock, mover=mover)
        self.assertTrue((self.app / 'novel_tts.py').exists())
        with self.assertRaises(manager.TransactionFailure): manager.execute_uninstall(self.config, ctl=self.ctl, clock=self.clock, verifier=lambda _: (_ for _ in ()).throw(ValueError('verify failure')))
        self.assertTrue((self.app / 'novel_tts.py').exists())

    def test_quarantine_failure_for_every_managed_category_rolls_back(self):
        self.install_components(); real_move = shutil.move
        targets = (
            self.units / manager.SERVICE,
            self.units / f'{manager.SERVICE}.d/override.conf',
            self.launcher,
            self.app / 'novel_tts.py',
        )
        for failing_path in targets:
            with self.subTest(path=failing_path):
                def mover(source, target, failing=failing_path):
                    if Path(source) == failing: raise OSError(f'quarantine failure: {failing.name}')
                    return real_move(source, target)
                with self.assertRaises(manager.TransactionFailure) as raised:
                    manager.execute_uninstall(self.config, ctl=self.ctl, clock=self.clock, mover=mover)
                self.assertEqual(raised.exception.result['rollback_status'], 'complete')
                self.assertTrue(failing_path.exists()); self.assertTrue(all(self.ctl.active.values())); self.assertTrue(all(self.ctl.enabled.values()))

    def test_target_swapped_for_symlink_after_plan_is_rejected_and_recovered(self):
        self.install_components(); outside = self.root / 'outside-launcher'; outside.write_text('external-safe')
        class SwappingController(FakeController):
            def __call__(inner, *args, check=True):
                result = super(SwappingController, inner).__call__(*args, check=check)
                if args[0] == 'disable':
                    self.launcher.unlink(); self.launcher.symlink_to(outside)
                return result
        ctl = SwappingController()
        with self.assertRaises(manager.TransactionFailure) as raised:
            manager.execute_uninstall(self.config, ctl=ctl, clock=self.clock)
        self.assertTrue(raised.exception.result['rollback_performed'])
        self.assertEqual(raised.exception.result['rollback_status'], 'complete')
        self.assertEqual(outside.read_text(), 'external-safe')
        self.assertFalse(outside.is_symlink()); self.assertTrue(manager._owned_launcher(self.launcher))

    def test_snapshot_failure_is_pre_destructive_and_rollback_failure_keeps_both_errors(self):
        self.install_components()
        with patch.object(manager.InstallTransaction, 'snapshot', side_effect=OSError('snapshot failure')):
            with self.assertRaisesRegex(OSError, 'snapshot failure'): manager.execute_uninstall(self.config, ctl=self.ctl, clock=self.clock)
        self.assertEqual(self.ctl.calls, []); self.assertTrue(self.launcher.exists())
        ctl = FakeController({'daemon-reload': 2})
        with self.assertRaises(manager.TransactionFailure) as raised: manager.execute_uninstall(self.config, ctl=ctl, clock=self.clock)
        self.assertIsNotNone(raised.exception.rollback_error); self.assertEqual(raised.exception.result['rollback_status'], 'partial')

    def test_file_and_service_state_restore_failures_are_reported_as_partial(self):
        cases = ('files', 'enabled', 'active')
        for case in cases:
            with self.subTest(case=case):
                self.install_components(); ctl = FakeController({'enable': 1} if case == 'enabled' else {'start': 1} if case == 'active' else {})
                context = patch.object(manager, '_remove_owned', side_effect=OSError('file restore failure')) if case == 'files' else contextlib.nullcontext()
                with context, self.assertRaises(manager.TransactionFailure) as raised:
                    manager.execute_uninstall(
                        self.config, ctl=ctl, clock=self.clock,
                        verifier=lambda _: (_ for _ in ()).throw(ValueError('original verification failure')),
                    )
                self.assertIn('original verification failure', str(raised.exception.original))
                self.assertIsNotNone(raised.exception.rollback_error)
                self.assertEqual(raised.exception.result['rollback_status'], 'partial')
                if self.app.exists(): shutil.rmtree(self.app)
                if self.units.exists(): shutil.rmtree(self.units)
                self.launcher.unlink(missing_ok=True)

    def test_quarantine_restore_failure_preserves_both_errors(self):
        self.install_components()
        def restore_mover(source, target):
            raise OSError('quarantine restore failure')
        with self.assertRaises(manager.TransactionFailure) as raised:
            manager.execute_uninstall(
                self.config, ctl=self.ctl, clock=self.clock,
                restore_mover=restore_mover,
                verifier=lambda _: (_ for _ in ()).throw(ValueError('original verification failure')),
            )
        self.assertIn('original verification failure', str(raised.exception.original))
        self.assertIn('quarantine restore failure', str(raised.exception.rollback_error))
        self.assertTrue(raised.exception.result['rollback_performed'])
        self.assertEqual(raised.exception.result['rollback_status'], 'partial')

    def test_cli_yes_non_tty_cancel_and_single_json_document(self):
        self.install_components()
        original = {p: p.read_bytes() for p in (self.config_path, self.launcher, self.app / 'novel_tts.py')}
        with patch.object(manager, 'read_config', return_value=self.config):
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, '--yes'):
                manager.main(['uninstall'], ctl=self.ctl, interactive=False)
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, 'cancelada'):
                manager.main(['uninstall'], ctl=self.ctl, interactive=True, input_fn=lambda _: 'não')
            json_error = io.StringIO(); prompts = []
            with contextlib.redirect_stdout(json_error), self.assertRaisesRegex(ValueError, '--yes'):
                manager.main(['uninstall', '--json'], ctl=self.ctl, interactive=True, input_fn=lambda prompt: prompts.append(prompt) or 'sim')
            self.assertEqual(json_error.getvalue(), ''); self.assertEqual(prompts, [])
            self.assertEqual(original, {p: p.read_bytes() for p in original}); self.assertEqual(self.ctl.calls, [])
            output = io.StringIO()
            with contextlib.redirect_stdout(output): code = manager.main(['uninstall', '--yes', '--json'], ctl=self.ctl, interactive=False)
        self.assertEqual(code, 0); parsed = json.loads(output.getvalue()); self.assertTrue(parsed['removed'])
        self.assertNotIn(self.config['token'], output.getvalue()); self.assertNotIn('Authorization', output.getvalue())


if __name__ == '__main__': unittest.main()
