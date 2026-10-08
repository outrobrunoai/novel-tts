import contextlib
import hashlib
import importlib.util
import io
import json
import marshal
import os
import re
import shutil
import sys
import struct
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import nlr_config
import novel_tts as manager


class FakeSystemctl:
    def __init__(self):
        self.calls = []
        self.active = {manager.SERVICE: True, manager.CACHE: True}
        self.enabled = {manager.SERVICE: True, manager.CACHE: True}
    def __call__(self, *args, check=True):
        self.calls.append(args)
        action, *units = args
        if action in ('stop', 'start'):
            for name in units:
                if name in self.active: self.active[name] = action == 'start'
        elif action in ('enable', 'disable'):
            for name in units:
                if name in self.enabled: self.enabled[name] = action == 'enable'
        if action == 'is-active': output = ('active' if self.active[units[0]] else 'inactive') + '\n'
        elif action == 'is-enabled': output = ('enabled' if self.enabled[units[0]] else 'disabled') + '\n'
        else: output = ''
        return SimpleNamespace(stdout=output)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = self.root / 'home'
        self.home.mkdir()
        self.config_path = self.home / '.config/novel-local-reader/config.json'
        self.units = self.home / '.config/systemd/user'
        self.app = self.home / '.local/share/novel-local-reader'
        self.qwen = self.root / 'qwen'
        (self.qwen / 'build').mkdir(parents=True)
        self.server = self.qwen / 'build/tts-server'; self.server.write_text('x'); self.server.chmod(0o755)
        self.assets = [self.root / name for name in ('model.gguf', 'codec.gguf', 'voice.spk', 'voice.rvq', 'voice.txt')]
        for path in self.assets: path.write_text('fixture')
        self.ctl = FakeSystemctl()
        self.clock = lambda: datetime(2026, 9, 25, 12, 0, 0, 123456)
        self.subprocess_calls = []
        def tripwire(*args, **kwargs):
            self.subprocess_calls.append((args, kwargs))
            raise AssertionError('unmocked subprocess blocked')
        self.patches = [
            patch.object(manager, 'CONFIG_PATH', self.config_path), patch.object(manager, 'UNITS', self.units),
            patch.object(nlr_config, 'CONFIG_PATH', self.config_path),
            patch.object(manager, 'read_config', side_effect=lambda path=None:
                         nlr_config.read_config(self.config_path if path is None else path)),
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

    def setup_args(self, command='setup'):
        model, codec, spk, rvq, text = self.assets
        return [command, '--qwen-root', str(self.qwen), '--model', str(model), '--codec', str(codec),
                '--voice-name', 'fixture', '--voice-spk', str(spk), '--voice-rvq', str(rvq), '--voice-text', str(text),
                '--cache-dir', str(self.root / 'cache')]

    def invoke(self, args, ready=None, interactive=False, **kwargs):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = manager.main(args, ctl=self.ctl, ready=(lambda _: None) if ready is None else ready, interactive=interactive, **kwargs)
        return code, output.getvalue()

    def schema3_fixture(self):
        config = manager.build_config(qwen_root=self.qwen, model=self.assets[0], codec=self.assets[1],
            voice_name='fixture', voice_spk=self.assets[2], voice_rvq=self.assets[3],
            voice_text=self.assets[4], cache_dir=self.root / 'cache', cache_limit_mb=1234,
            require_mount=False)
        config['data_root'] = str(self.root / 'external-data')
        config['profiles']['qwen']['argv'].extend(['--custom-runtime-flag', 'retained-value'])
        config['profiles']['qwen']['voices']['second-voice'] = {
            'spk': str(self.assets[2]), 'rvq': str(self.assets[3]), 'text': str(self.assets[4])
        }
        config['profiles']['alternate'] = {
            'backend': 'qwen3', 'cwd': str(self.qwen),
            'argv': ['/custom/alternate-server', '--custom', 'alternate-value'],
            'voices': {'alternate-voice': {'spk': 'alt.spk', 'rvq': 'alt.rvq', 'text': 'alt.txt'}}
        }
        config['custom_profile_metadata'] = {'retain': ['all', 'fields']}
        return config

    def seed_package_install(self, config, marker):
        source = self.root / f'package-{marker}'
        source.mkdir()
        for name in ('novel_tts.py', 'nlr_config.py', 'companion_server.py'):
            (source / name).write_text(f'{marker}:{name}\n')
        transaction = manager.InstallTransaction(config, ctl=self.ctl, ready=lambda _: None,
            source_dir=source, clock=self.clock)
        transaction.run()
        return source

    def seed_bytecode_upgrade(self):
        config = self.schema3_fixture()
        with patch.object(manager, 'validate', lambda _config: None):
            self.seed_package_install(config, 'bytecode-fixture')
        self.ctl.active = {manager.SERVICE: False, manager.CACHE: False}
        self.ctl.enabled = {manager.SERVICE: False, manager.CACHE: False}
        self.ctl.calls.clear()
        return config

    @staticmethod
    def valid_pyc(source='pass\n'):
        header = (importlib.util.MAGIC_NUMBER + struct.pack('<I', 0) +
                  struct.pack('<II', 1, len(source)))
        return header + marshal.dumps(compile(source, '<transient-fixture>', 'exec'))

    @staticmethod
    def bytecode_filename(module, optimization=None):
        tag = sys.implementation.cache_tag
        suffix = f'.opt-{optimization}' if optimization is not None else ''
        return f'{module}.{tag}{suffix}.pyc'

    def seed_real_owned_application(self, config=None):
        config = self.schema3_fixture() if config is None else config
        transaction = manager.InstallTransaction(
            config, ctl=self.ctl, ready=lambda _: None,
            source_dir=Path(manager.__file__).resolve().parent, clock=self.clock,
        )
        transaction.run()
        return config

    def test_ready_timeout_is_validated_before_any_side_effect(self):
        with self.assertRaisesRegex(ValueError, 'ready-timeout'):
            self.invoke([*self.setup_args(), '--yes', '--ready-timeout', '5'])
        self.assertEqual(self.ctl.calls, [])
        self.assertFalse(self.config_path.exists())

    def test_cli_forwards_ready_timeout_to_readiness_check(self):
        seen = []
        with patch.object(manager, 'wait_ready', lambda config, timeout: seen.append(timeout)):
            code = manager.main([*self.setup_args(), '--yes', '--ready-timeout', '300'],
                                ctl=self.ctl, interactive=False)
        self.assertEqual(code, 0)
        self.assertEqual(seen, [300])

    def test_default_ready_timeout_covers_a_cold_qwen_start(self):
        seen = []
        with patch.object(manager, 'wait_ready', lambda config, timeout: seen.append(timeout)):
            manager.main([*self.setup_args(), '--yes'], ctl=self.ctl, interactive=False)
        self.assertEqual(seen, [240])

    def test_token_rotation_snapshots_rewrites_and_restarts_only_the_cache(self):
        self.seed_real_owned_application()
        before = json.loads(self.config_path.read_text())['token']
        snapshots = len(manager.valid_backups())
        self.ctl.calls.clear()
        code, output = self.invoke(['token', '--rotate', '--yes'])
        token = output.strip()
        saved = json.loads(self.config_path.read_text())
        self.assertEqual(code, 0)
        self.assertEqual(saved['token'], token)
        self.assertNotEqual(token, before)
        self.assertGreaterEqual(len(token), 32)
        self.assertEqual(self.config_path.stat().st_mode & 0o777, 0o600)
        self.assertIn(('try-restart', manager.CACHE), self.ctl.calls)
        self.assertNotIn(('try-restart', manager.SERVICE), self.ctl.calls)
        self.assertEqual(len(manager.valid_backups()), snapshots + 1)

    def test_token_without_rotate_only_prints_the_current_token(self):
        self.seed_real_owned_application()
        current = json.loads(self.config_path.read_text())['token']
        self.ctl.calls.clear()
        code, output = self.invoke(['token'])
        self.assertEqual((code, output.strip()), (0, current))
        self.assertEqual(self.ctl.calls, [])

    def test_run_cli_reports_a_transaction_failure_as_one_json_line(self):
        failure = manager.TransactionFailure(RuntimeError('private detail'), stage='swap_failed_stage')
        with patch.object(manager, 'main', side_effect=failure):
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                code = manager.run_cli(['restore', '--json'])
            lines = stderr.getvalue().strip().splitlines()
            self.assertEqual((code, len(lines)), (1, 1))
            record = json.loads(lines[0])
            self.assertFalse(record['ok'])
            self.assertNotIn('private detail', lines[0])
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                self.assertEqual(manager.run_cli(['restore']), 1)
            self.assertTrue(stderr.getvalue().startswith('Novel TTS:'))

    def test_missing_configuration_points_to_the_installer(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = manager.run_cli(['token'])
        self.assertEqual(code, 1)
        self.assertIn('install-service.sh', stderr.getvalue())
        self.assertNotIn(str(self.home), stderr.getvalue())

    def test_other_expected_failures_stay_one_redacted_line_with_status_1(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = manager.run_cli(['restore'])
        self.assertEqual(code, 1)
        self.assertIn('restore exige --backup-id', stderr.getvalue())
        self.assertEqual(len(stderr.getvalue().strip().splitlines()), 1)

    def test_setup_creates_the_private_cache_directory_before_starting_units(self):
        # The cache unit mounts $HOME read-only and only whitelists an EXISTING cache_dir.
        cache = self.root / 'cache'
        self.assertFalse(cache.exists())
        observed = []
        real = self.ctl

        def ctl(*args, check=True):
            if args[0] == 'start':
                observed.append(cache.is_dir())
            return real(*args, check=check)

        self.ctl = ctl
        code, _ = self.invoke([*self.setup_args(), '--yes'])
        self.assertEqual(code, 0)
        self.assertTrue(observed and all(observed), observed)
        self.assertEqual(cache.stat().st_mode & 0o777, 0o700)

    def test_upgrade_recreates_a_missing_cache_directory(self):
        config = self.seed_bytecode_upgrade()
        cache = Path(config['cache_dir'])
        shutil.rmtree(cache)
        code, _ = self.upgrade_bytecode_fixture(config)
        self.assertEqual(code, 0)
        self.assertTrue(cache.is_dir())

    def test_cache_directory_failure_rolls_back_with_a_safe_code(self):
        blocked = self.root / 'not-a-directory'
        blocked.write_text('file in the way')
        args = [item if item != str(self.root / 'cache') else str(blocked / 'cache') for item in self.setup_args()]
        with patch.object(manager, 'validate', lambda _config: None):
            with self.assertRaises(manager.TransactionFailure) as raised:
                self.invoke([*args, '--yes'])
        self.assertEqual(raised.exception.code, 'NLR_CACHE_DIR_FAILED')
        self.assertEqual(raised.exception.stage, 'prepare_cache')

    def test_token_rotation_snapshot_keeps_the_previous_token(self):
        self.seed_real_owned_application()
        before = json.loads(self.config_path.read_text())['token']
        self.invoke(['token', '--rotate', '--yes'])
        newest = max((item for item in manager.valid_backups()), key=lambda item: item['id'])
        self.assertEqual(newest['operation'], 'token-rotation')
        saved = json.loads((manager.backup_root() / newest['id'] / 'config.json').read_text())
        self.assertEqual(saved['token'], before)

    def test_token_rotation_requires_confirmation(self):
        self.seed_real_owned_application()
        original = self.config_path.read_bytes()
        snapshots = len(manager.valid_backups())
        self.ctl.calls.clear()
        with self.assertRaisesRegex(ValueError, '--yes'):
            self.invoke(['token', '--rotate'])
        self.assertEqual(self.config_path.read_bytes(), original)
        self.assertEqual(len(manager.valid_backups()), snapshots)
        self.assertEqual(self.ctl.calls, [])

    def test_token_rotation_without_an_installed_app_leaves_the_config_untouched(self):
        config = self.schema3_fixture()
        nlr_config.atomic_json(self.config_path, config)
        original = self.config_path.read_bytes()
        with self.assertRaises(ValueError):
            self.invoke(['token', '--rotate', '--yes'])
        self.assertEqual(self.config_path.read_bytes(), original)
        self.assertNotIn(('try-restart', manager.CACHE), self.ctl.calls)

    def test_token_rotation_reports_a_cache_that_did_not_restart(self):
        self.seed_real_owned_application()
        before = json.loads(self.config_path.read_text())['token']
        real = self.ctl

        def ctl(*args, check=True):
            if args[0] == 'try-restart':
                raise manager.subprocess.CalledProcessError(1, ['systemctl', '--user', *args])
            return real(*args, check=check)

        self.ctl = ctl
        with self.assertRaisesRegex(ValueError, 'cache não reiniciou.*token antigo'):
            self.invoke(['token', '--rotate', '--yes'])
        # the new token is on disk, so the message must tell the user how to finish
        self.assertNotEqual(json.loads(self.config_path.read_text())['token'], before)

    def upgrade_bytecode_fixture(self, config):
        with patch.object(manager, 'validate', lambda _config: None):
            return self.invoke(['upgrade', '--yes', '--json'], ready=lambda _: self.fail('unexpected readiness'))

    def test_upgrade_ignores_only_valid_transient_bytecode_and_restores_package_bytes(self):
        config = self.seed_bytecode_upgrade()
        original = {name: (self.app / name).read_bytes() for name in manager.PACKAGE_FILES}
        cache = self.app / '__pycache__'
        cache.mkdir()
        for name in manager.PACKAGE_FILES:
            (cache / self.bytecode_filename(Path(name).stem)).write_bytes(self.valid_pyc())
        (cache / self.bytecode_filename('novel_tts', 2)).write_bytes(self.valid_pyc('value = 2\n'))
        code, output = self.upgrade_bytecode_fixture(config)
        self.assertEqual(code, 0)
        snapshot = manager.backup_root() / json.loads(output)['backup_id']
        self.assertEqual(manager.validated_backup(snapshot.name)[0], snapshot)
        self.assertEqual(json.loads((snapshot / 'transient-artifacts.json').read_text()),
                         {'schema': 1, 'ignored_bytecode_count': 4})
        self.assertFalse((snapshot / 'app' / '__pycache__').exists())
        self.assertFalse(any(path.suffix == '.pyc' for path in snapshot.rglob('*')))
        self.assertEqual({name: (snapshot / 'app' / name).read_bytes() for name in manager.PACKAGE_FILES}, original)
        self.assertEqual(self.ctl.active, {manager.SERVICE: False, manager.CACHE: False})
        self.assertEqual(self.ctl.enabled, {manager.SERVICE: False, manager.CACHE: False})
        with patch.object(manager, 'validate', lambda _config: None):
            code, _ = self.invoke(['restore', '--backup-id', snapshot.name, '--yes', '--json'],
                                  ready=lambda _: self.fail('unexpected readiness'))
        self.assertEqual(code, 0)
        self.assertEqual({name: (self.app / name).read_bytes() for name in manager.PACKAGE_FILES}, original)
        self.assertFalse((self.app / '__pycache__').exists())
        transient = snapshot / 'transient-artifacts.json'
        transient.write_text(json.dumps({'schema': 1, 'ignored_bytecode_count': 10_000}))
        metadata_path = snapshot / 'snapshot.json'
        metadata = json.loads(metadata_path.read_text())
        metadata['checksums'] = manager._snapshot_checksums(snapshot)
        metadata_path.write_text(json.dumps(metadata))
        with self.assertRaisesRegex(ValueError, 'transitórios'):
            manager.validated_backup(snapshot.name)

    def test_bytecode_left_by_another_python_version_is_transient_too(self):
        # After a distro Python upgrade (or under a venv) the app directory keeps the
        # previous minor version's cache; it must not block snapshots, upgrades or setup.
        config = self.seed_bytecode_upgrade()
        cache = self.app / '__pycache__'
        cache.mkdir()
        foreign = struct.pack('<H', 3000) + b'\r\n' + self.valid_pyc()[4:]
        self.assertNotEqual(foreign[:4], importlib.util.MAGIC_NUMBER)
        (cache / 'novel_tts.cpython-39.pyc').write_bytes(foreign)
        snapshot = manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        self.assertEqual(json.loads((snapshot / 'transient-artifacts.json').read_text()),
                         {'schema': 1, 'ignored_bytecode_count': 1})
        self.assertFalse(any(path.suffix == '.pyc' for path in snapshot.rglob('*')))
        (cache / 'nlr_config.cpython-39.pyc').write_bytes(b'this is not python bytecode at all')
        with self.assertRaises(ValueError):
            manager.create_backup(config, ctl=self.ctl, clock=self.clock)

    def test_empty_bytecode_directory_is_allowed_and_excluded(self):
        config = self.seed_bytecode_upgrade()
        (self.app / '__pycache__').mkdir()
        code, output = self.upgrade_bytecode_fixture(config)
        self.assertEqual(code, 0)
        snapshot = manager.backup_root() / json.loads(output)['backup_id']
        self.assertEqual(json.loads((snapshot / 'transient-artifacts.json').read_text())
                         ['ignored_bytecode_count'], 0)
        self.assertFalse((snapshot / 'app' / '__pycache__').exists())

    def test_pre_manifest_known_package_with_bytecode_keeps_ownership_evidence_separate(self):
        config = self.seed_bytecode_upgrade()
        (self.app / manager.OWNERSHIP_FILE).unlink()
        digests = tuple(hashlib.sha256((self.app / name).read_bytes()).hexdigest()
                        for name in manager.PACKAGE_FILES)
        cache = self.app / '__pycache__'; cache.mkdir()
        (cache / self.bytecode_filename('nlr_config')).write_bytes(self.valid_pyc())
        with patch.object(manager, 'LEGACY_APP_DIGESTS', frozenset({digests})):
            code, output = self.upgrade_bytecode_fixture(config)
            self.assertEqual(code, 0)
            snapshot = manager.backup_root() / json.loads(output)['backup_id']
            self.assertEqual(manager.validated_backup(snapshot.name)[0], snapshot)
        self.assertTrue((snapshot / 'legacy-ownership.json').is_file())
        self.assertFalse((snapshot / 'app' / manager.OWNERSHIP_FILE).exists())
        self.assertFalse((snapshot / 'app' / '__pycache__').exists())

    def test_explicit_backup_without_bytecode_is_complete_and_restorable(self):
        config = self.seed_bytecode_upgrade()
        snapshot = manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        self.assertEqual(manager.validated_backup(snapshot.name)[0], snapshot)
        self.assertEqual(set(path.name for path in (snapshot / 'app').iterdir()),
                         manager.OWNED_APP_FILES)
        self.assertEqual(json.loads((snapshot / 'transient-artifacts.json').read_text()),
                         {'schema': 1, 'ignored_bytecode_count': 0})
        inventory = manager._snapshot_file_inventory(snapshot)
        self.assertFalse(any(name.endswith('.pyc') or '__pycache__' in Path(name).parts
                             for name in inventory))

    def test_explicit_backup_after_importing_three_modules_excludes_but_preserves_bytecode(self):
        previous = sys.dont_write_bytecode
        sys.dont_write_bytecode = False  # the test needs real bytecode even under -B
        self.addCleanup(setattr, sys, 'dont_write_bytecode', previous)
        config = self.seed_real_owned_application()
        cache = self.app / '__pycache__'
        sys.path.insert(0, str(self.app))
        try:
            for name in manager.PACKAGE_FILES:
                spec = importlib.util.spec_from_file_location(
                    f'_snapshot_import_{Path(name).stem}', self.app / name
                )
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
        finally:
            sys.path.remove(str(self.app))
        # Executing each installed module through its real source loader creates
        # the same interpreter bytecode directory seen in production.
        for name in manager.PACKAGE_FILES:
            self.assertTrue((cache / self.bytecode_filename(Path(name).stem)).is_file())
        self.assertEqual(len(list(cache.glob('*.pyc'))), len(manager.PACKAGE_FILES))
        snapshot = manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        self.assertEqual(manager.validated_backup(snapshot.name)[0], snapshot)
        self.assertEqual(json.loads((snapshot / 'transient-artifacts.json').read_text()),
                         {'schema': 1, 'ignored_bytecode_count': len(manager.PACKAGE_FILES)})
        self.assertFalse((snapshot / 'app' / '__pycache__').exists())
        self.assertFalse(any(name.endswith('.pyc') or '__pycache__' in Path(name).parts
                             for name in manager._snapshot_file_inventory(snapshot)))
        self.assertEqual(len(list(cache.glob('*.pyc'))), len(manager.PACKAGE_FILES))

    def test_restore_from_explicit_backup_restores_only_managed_application_files(self):
        config = self.seed_real_owned_application()
        self.ctl.active = {manager.SERVICE: False, manager.CACHE: False}
        self.ctl.enabled = {manager.SERVICE: False, manager.CACHE: False}
        snapshot = manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        self.seed_package_install(config, 'replacement-after-backup')
        result = manager.transactional_restore(
            snapshot.name, config, ctl=self.ctl, ready=lambda _: None,
            source_dir=Path(manager.__file__).resolve().parent, clock=self.clock,
        )
        self.assertEqual(manager.validated_backup(snapshot.name)[0], snapshot)
        self.assertEqual(set(path.name for path in self.app.iterdir()), manager.OWNED_APP_FILES)
        self.assertFalse((self.app / '__pycache__').exists())
        self.assertEqual({name: (self.app / name).read_bytes()
                          for name in manager.PACKAGE_FILES},
                         {name: (snapshot / 'app' / name).read_bytes()
                          for name in manager.PACKAGE_FILES})
        self.assertEqual(self.ctl.active, {manager.SERVICE: False, manager.CACHE: False})
        self.assertEqual(self.ctl.enabled, {manager.SERVICE: False, manager.CACHE: False})
        self.assertTrue((result / 'snapshot-ready').is_file())

    def test_explicit_backup_preserves_independent_active_disabled_unit_states(self):
        config = self.seed_bytecode_upgrade()
        self.ctl.active = {manager.SERVICE: True, manager.CACHE: True}
        self.ctl.enabled = {manager.SERVICE: False, manager.CACHE: False}
        snapshot = manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        self.assertEqual(json.loads((snapshot / 'states.json').read_text()), {
            manager.SERVICE: {'active': True, 'enabled': False},
            manager.CACHE: {'active': True, 'enabled': False},
        })
        self.assertEqual(manager.validated_backup(snapshot.name)[0], snapshot)

    def test_explicit_backup_of_known_legacy_application_uses_restricted_evidence(self):
        config = self.seed_bytecode_upgrade()
        (self.app / manager.OWNERSHIP_FILE).unlink()
        digests = tuple(hashlib.sha256((self.app / name).read_bytes()).hexdigest()
                        for name in manager.PACKAGE_FILES)
        with patch.object(manager, 'LEGACY_APP_DIGESTS', frozenset({digests})):
            snapshot = manager.create_backup(config, ctl=self.ctl, clock=self.clock)
            self.assertEqual(manager.validated_backup(snapshot.name)[0], snapshot)
        self.assertTrue((snapshot / 'legacy-ownership.json').is_file())
        self.assertFalse((snapshot / 'app' / manager.OWNERSHIP_FILE).exists())
        self.assertFalse((snapshot / 'app' / '__pycache__').exists())

    def test_explicit_backup_rejects_symlink_invalid_bytecode_extra_and_tampered_module(self):
        config = self.seed_bytecode_upgrade()
        baseline = {item['id'] for item in manager.valid_backups()}
        cache = self.app / '__pycache__'
        cache.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        cache.unlink()
        cache.mkdir()
        (cache / self.bytecode_filename('novel_tts')).write_bytes(b'not-valid-bytecode')
        with self.assertRaises(ValueError):
            manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        shutil.rmtree(cache)
        (self.app / 'unexpected.bin').write_bytes(b'x')
        with self.assertRaises(ValueError):
            manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        (self.app / 'unexpected.bin').unlink()
        module = self.app / manager.PACKAGE_FILES[0]
        module.write_bytes(module.read_bytes() + b'changed')
        with self.assertRaises(ValueError):
            manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        self.assertEqual({item['id'] for item in manager.valid_backups()}, baseline)

    def test_valid_bytecode_appearing_during_snapshot_copy_is_ignored(self):
        config = self.seed_bytecode_upgrade()
        original_read = manager._installed_app_payloads
        calls = {'count': 0}

        def add_bytecode_after_capture(app, *, legacy=False):
            result = original_read(app, legacy=legacy)
            calls['count'] += 1
            if calls['count'] == 1:
                cache = self.app / '__pycache__'
                cache.mkdir()
                (cache / self.bytecode_filename('nlr_config')).write_bytes(self.valid_pyc())
            return result

        with patch.object(manager, '_installed_app_payloads', side_effect=add_bytecode_after_capture):
            snapshot = manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        self.assertEqual(calls['count'], 3)
        self.assertEqual(manager.validated_backup(snapshot.name)[0], snapshot)
        self.assertEqual(json.loads((snapshot / 'transient-artifacts.json').read_text())
                         ['ignored_bytecode_count'], 1)
        self.assertFalse((snapshot / 'app' / '__pycache__').exists())

    def test_unknown_file_appearing_during_copy_aborts_without_snapshot_marker(self):
        config = self.seed_bytecode_upgrade()
        baseline = {item['id'] for item in manager.valid_backups()}
        original_read = manager._installed_app_payloads
        calls = {'count': 0}

        def add_unknown_after_capture(app, *, legacy=False):
            result = original_read(app, legacy=legacy)
            calls['count'] += 1
            if calls['count'] == 1:
                (self.app / 'unexpected.bin').write_bytes(b'x')
            return result

        with patch.object(manager, '_installed_app_payloads', side_effect=add_unknown_after_capture):
            with self.assertRaises(ValueError):
                manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        self.assertFalse(any((path / 'snapshot-ready').exists()
                             for path in manager.backup_root().iterdir()
                             if path.is_dir() and path.name not in baseline))
        self.assertFalse(any(path.name.startswith('.nlr-snapshot-')
                             for path in manager.backup_root().iterdir()))

    def test_explicit_backup_checksum_failure_never_publishes_snapshot(self):
        config = self.seed_bytecode_upgrade()
        baseline = {item['id'] for item in manager.valid_backups()}
        with patch.object(manager, '_snapshot_checksums', side_effect=OSError('checksum failure')):
            with self.assertRaises(OSError):
                manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        self.assertEqual({item['id'] for item in manager.valid_backups()}, baseline)
        self.assertFalse(any(path.name.startswith('.nlr-snapshot-')
                             for path in manager.backup_root().iterdir()))

    def test_snapshot_with_bytecode_inside_managed_app_remains_ineligible(self):
        config = self.seed_bytecode_upgrade()
        snapshot = manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        app_cache = snapshot / 'app' / '__pycache__'
        app_cache.mkdir()
        (app_cache / self.bytecode_filename('novel_tts')).write_bytes(self.valid_pyc())
        metadata_path = snapshot / 'snapshot.json'
        metadata = json.loads(metadata_path.read_text())
        metadata['checksums'] = manager._snapshot_checksums(snapshot)
        metadata_path.write_text(json.dumps(metadata))
        with self.assertRaisesRegex(ValueError, 'transitórios'):
            manager.validated_backup(snapshot.name)

    def test_upgrade_and_explicit_backup_share_the_application_snapshot_routine(self):
        config = self.seed_bytecode_upgrade()
        original = manager._copy_owned_application_snapshot
        with patch.object(manager, '_copy_owned_application_snapshot', wraps=original) as copier:
            manager.create_backup(config, ctl=self.ctl, clock=self.clock)
            copier.assert_called_once()
            source = self.root / 'next-host-package'
            source.mkdir()
            for name in manager.PACKAGE_FILES:
                (source / name).write_text(f'next package: {name}\n')
            transaction = manager.InstallTransaction(
                config, ctl=self.ctl, ready=lambda _: None,
                source_dir=source, clock=self.clock,
            )
            transaction.run(operation='upgrade')
            self.assertEqual(copier.call_count, 2)

    def test_bytecode_lookalikes_unknown_entries_and_limits_block_before_mutation(self):
        self.seed_bytecode_upgrade()
        cache = self.app / '__pycache__'
        baseline = {item['id'] for item in manager.valid_backups()}
        cases = (
            'cache_symlink', 'file_symlink', 'fifo', 'nested', 'orphan', 'unknown_stem',
            'root_pyc', 'root_extra', 'root_source', 'root_executable', 'root_manifest',
            'root_dir', 'cache_extra', 'bad_optimization', 'invalid_bytecode', 'too_many',
            'too_large', 'too_large_total',
        )
        for case in cases:
            with self.subTest(case=case):
                if cache.is_symlink() or cache.is_file(): cache.unlink()
                elif cache.exists(): shutil.rmtree(cache)
                for extra in (self.app / f'orphan.{sys.implementation.cache_tag}.pyc', self.app / 'extra.json',
                              self.app / 'extra.py', self.app / 'extra-bin', self.app / 'manifest.json'):
                    extra.unlink(missing_ok=True)
                extra_dir = self.app / 'plugins'
                if extra_dir.exists(): shutil.rmtree(extra_dir)
                if case == 'cache_symlink': cache.symlink_to(self.root, target_is_directory=True)
                else:
                    cache.mkdir()
                    if case == 'file_symlink': (cache / self.bytecode_filename('novel_tts')).symlink_to(self.assets[0])
                    elif case == 'fifo': os.mkfifo(cache / self.bytecode_filename('novel_tts'))
                    elif case == 'nested': (cache / 'nested').mkdir()
                    elif case == 'orphan': (cache / (self.bytecode_filename('novel_tts') + '.tmp')).write_bytes(b'x')
                    elif case == 'unknown_stem': (cache / self.bytecode_filename('unknown')).write_bytes(b'x')
                    elif case == 'invalid_bytecode': (cache / self.bytecode_filename('novel_tts')).write_bytes(b'invalid pyc')
                    elif case == 'root_pyc': (self.app / f'orphan.{sys.implementation.cache_tag}.pyc').write_bytes(b'x')
                    elif case == 'root_extra': (self.app / 'extra.json').write_bytes(b'{}')
                    elif case == 'root_source': (self.app / 'extra.py').write_bytes(b'x')
                    elif case == 'root_executable':
                        executable = self.app / 'extra-bin'; executable.write_bytes(b'x'); executable.chmod(0o755)
                    elif case == 'root_manifest': (self.app / 'manifest.json').write_bytes(b'{}')
                    elif case == 'root_dir': extra_dir.mkdir()
                    elif case == 'cache_extra': (cache / 'extra.json').write_bytes(b'{}')
                    elif case == 'bad_optimization': (cache / self.bytecode_filename('novel_tts', 9)).write_bytes(b'x')
                    elif case == 'too_many':
                        for i in range(3): (cache / self.bytecode_filename('novel_tts', i)).write_bytes(self.valid_pyc())
                    elif case == 'too_large': (cache / self.bytecode_filename('novel_tts')).write_bytes(self.valid_pyc())
                    elif case == 'too_large_total':
                        (cache / self.bytecode_filename('novel_tts')).write_bytes(self.valid_pyc())
                        (cache / self.bytecode_filename('nlr_config')).write_bytes(self.valid_pyc('x = 4\n'))
                self.ctl.calls.clear()
                limits = {'MAX_TRANSIENT_BYTECODE_FILES': 2} if case == 'too_many' else (
                    {'MAX_TRANSIENT_BYTECODE_FILE_BYTES': 3} if case == 'too_large' else (
                    {'MAX_TRANSIENT_BYTECODE_BYTES': 3} if case == 'too_large_total' else {}))
                with contextlib.ExitStack() as stack:
                    for limit_name, limit_value in limits.items():
                        stack.enter_context(patch.object(manager, limit_name, limit_value))
                    stack.enter_context(patch.object(manager, 'validate', lambda _config: None))
                    with self.assertRaises(manager.TransactionFailure):
                        self.invoke(['upgrade', '--yes', '--json'])
                self.assertEqual({item['id'] for item in manager.valid_backups()}, baseline)
                self.assertFalse(any(call[0] in ('stop', 'start', 'enable', 'disable') for call in self.ctl.calls))

    def test_snapshot_checksum_failure_has_no_marker_or_service_mutation(self):
        self.seed_bytecode_upgrade()
        baseline = {item['id'] for item in manager.valid_backups()}
        original_config = self.config_path.read_bytes()
        with patch.object(manager, '_snapshot_checksums', side_effect=OSError('injected checksum failure')), \
                patch.object(manager, 'validate', lambda _config: None):
            with self.assertRaises(manager.TransactionFailure) as raised:
                self.invoke(['upgrade', '--yes', '--json'])
        self.assertEqual(raised.exception.stage, 'snapshot')
        self.assertEqual({item['id'] for item in manager.valid_backups()}, baseline)
        self.assertFalse(any(p.name.startswith('.nlr-snapshot-') for p in manager.backup_root().iterdir()))
        self.assertEqual(self.config_path.read_bytes(), original_config)
        self.assertFalse(any(call[0] in ('stop', 'start', 'enable', 'disable') for call in self.ctl.calls))

    def test_snapshot_copy_failure_has_no_marker_or_service_mutation(self):
        self.seed_bytecode_upgrade()
        baseline = {item['id'] for item in manager.valid_backups()}
        original_config = self.config_path.read_bytes()
        with patch.object(manager.shutil, 'copy2', side_effect=OSError('injected copy failure')), \
                patch.object(manager, 'validate', lambda _config: None):
            with self.assertRaises(manager.TransactionFailure) as raised:
                self.invoke(['upgrade', '--yes', '--json'])
        self.assertEqual(raised.exception.stage, 'snapshot')
        self.assertEqual({item['id'] for item in manager.valid_backups()}, baseline)
        self.assertFalse(any(p.name.startswith('.nlr-snapshot-') for p in manager.backup_root().iterdir()))
        self.assertEqual(self.config_path.read_bytes(), original_config)
        self.assertFalse(any(call[0] in ('stop', 'start', 'enable', 'disable') for call in self.ctl.calls))

    def test_incomplete_prior_snapshot_is_ignored_and_never_selected(self):
        config = self.seed_bytecode_upgrade()
        incomplete = manager.backup_root() / 'incomplete-prior'
        incomplete.mkdir()
        (incomplete / 'states.json').write_text('{}')
        self.assertNotIn(incomplete.name, {item['id'] for item in manager.valid_backups()})
        with self.assertRaises(ValueError): manager.validated_backup(incomplete.name)
        self.ctl.calls.clear()
        with self.assertRaises(ValueError):
            self.invoke(['restore', '--backup-id', incomplete.name, '--yes'])
        self.assertEqual(self.ctl.calls, [])
        code, output = self.upgrade_bytecode_fixture(config)
        self.assertEqual(code, 0)
        self.assertNotEqual(json.loads(output)['backup_id'], incomplete.name)
        self.assertFalse((incomplete / 'snapshot-ready').exists())

    def make_snapshot(self, config, operation, **changes):
        """Persist `changes` into the saved configuration, then snapshot it as `operation`."""
        if changes:
            saved = json.loads(self.config_path.read_text())
            saved.update(changes)
            nlr_config.atomic_json(self.config_path, saved)
            config = saved
        return manager.create_backup(config, ctl=self.ctl, clock=self.clock, operation=operation)

    def test_rollback_restores_the_state_before_the_last_upgrade(self):
        config = self.seed_bytecode_upgrade()
        original = {name: (self.app / name).read_bytes() for name in manager.PACKAGE_FILES}
        code, output = self.upgrade_bytecode_fixture(config)
        self.assertEqual(code, 0)
        upgrade_id = json.loads(output)['backup_id']
        self.assertNotEqual({name: (self.app / name).read_bytes() for name in manager.PACKAGE_FILES}, original)
        code, output = self.invoke(['rollback', '--yes', '--json'])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output)['backup_id'], upgrade_id)
        self.assertEqual({name: (self.app / name).read_bytes() for name in manager.PACKAGE_FILES}, original)

    def test_rollback_only_considers_setup_and_upgrade_snapshots(self):
        config = self.seed_real_owned_application()
        wanted = self.make_snapshot(config, 'upgrade')
        for operation in ('backup', 'token-rotation', 'restore-recovery'):
            self.make_snapshot(config, operation)
        operations = {item['operation'] for item in manager.valid_backups()}
        self.assertTrue({'upgrade', 'backup', 'token-rotation', 'restore-recovery'} <= operations)
        self.assertEqual(manager.latest_validated_backup_id(), wanted.name)
        code, output = self.invoke(['rollback', '--dry-run', '--json'])
        plan = json.loads(output)
        self.assertEqual((plan['backup_id'], plan['snapshot_operation']), (wanted.name, 'upgrade'))
        self.assertTrue(plan['snapshot_created_at'])
        self.assertEqual(plan['snapshot_app_version'], manager.VERSION)

    def test_rollback_restores_the_newest_of_several_valid_snapshots(self):
        config = self.seed_real_owned_application()
        self.make_snapshot(config, 'upgrade', cache_limit_mb=1111)
        newest = self.make_snapshot(config, 'upgrade', cache_limit_mb=2222)
        saved = json.loads(self.config_path.read_text())
        saved['cache_limit_mb'] = 3333
        nlr_config.atomic_json(self.config_path, saved)
        code, output = self.invoke(['rollback', '--yes', '--json'])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output)['backup_id'], newest.name)
        self.assertEqual(json.loads(self.config_path.read_text())['cache_limit_mb'], 2222)

    def test_rollback_skips_a_tampered_newer_snapshot_and_says_so(self):
        config = self.seed_real_owned_application()
        older = self.make_snapshot(config, 'upgrade')
        newer = self.make_snapshot(config, 'upgrade')
        with (newer / 'config.json').open('ab') as stream:
            stream.write(b' ')  # checksum no longer matches; snapshot-ready is still present
        skipped = []
        self.assertEqual(manager.latest_validated_backup_id(skipped), older.name)
        self.assertEqual([name for name, _ in skipped], [newer.name])
        self.assertIn('Checksum', skipped[0][1])
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.invoke(['rollback', '--dry-run', '--json'])
        self.assertIn(newer.name, stderr.getvalue())
        self.assertNotIn(str(self.root), stderr.getvalue())

    def test_restore_announces_the_snapshot_before_asking_for_confirmation(self):
        config = self.seed_real_owned_application()
        snapshot = self.make_snapshot(config, 'upgrade')
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.invoke(['restore', '--backup-id', snapshot.name, '--yes', '--json'])
        self.assertIn(snapshot.name, stderr.getvalue())
        self.assertIn('upgrade', stderr.getvalue())

    def test_rollback_with_nothing_eligible_explains_why(self):
        config = self.seed_real_owned_application()
        self.make_snapshot(config, 'backup')  # an explicit backup is not "the last upgrade"
        with self.assertRaisesRegex(ValueError, 'setup ou upgrade.*backups --json.*restore --backup-id'):
            self.invoke(['rollback', '--dry-run'])

    def test_rollback_does_not_accept_an_explicit_backup_id(self):
        with self.assertRaisesRegex(ValueError, 'restore --backup-id'):
            self.invoke(['rollback', '--backup-id', 'anything', '--dry-run'])

    def test_rollback_without_any_validated_snapshot_explains_what_to_do(self):
        with self.assertRaisesRegex(ValueError, 'backups --json'):
            self.invoke(['rollback', '--dry-run'])

    def test_upgrade_rollback_uses_new_snapshot_not_prior_incomplete_directory(self):
        self.seed_bytecode_upgrade()
        original_config = self.config_path.read_bytes()
        original_app = {name: (self.app / name).read_bytes() for name in manager.OWNED_APP_FILES}
        incomplete = manager.backup_root() / 'incomplete-prior'
        incomplete.mkdir()
        (incomplete / 'states.json').write_text('{}')
        base_controller = self.ctl

        class FailFirstReload:
            failed = False
            def __call__(self, *args, **kwargs):
                if args[0] == 'daemon-reload' and not self.failed:
                    self.failed = True
                    raise RuntimeError('injected reload failure')
                return base_controller(*args, **kwargs)

        with patch.object(self, 'ctl', FailFirstReload()), patch.object(manager, 'validate', lambda _config: None):
            with self.assertRaises(manager.TransactionFailure) as raised:
                self.invoke(['upgrade', '--yes', '--json'])
        self.assertEqual(raised.exception.rollback_status, 'complete')
        self.assertEqual(self.config_path.read_bytes(), original_config)
        self.assertEqual({name: (self.app / name).read_bytes() for name in manager.OWNED_APP_FILES}, original_app)
        self.assertEqual(base_controller.active, {manager.SERVICE: False, manager.CACHE: False})
        self.assertEqual(base_controller.enabled, {manager.SERVICE: False, manager.CACHE: False})
        self.assertFalse((incomplete / 'snapshot-ready').exists())
        self.assertEqual((incomplete / 'states.json').read_text(), '{}')
        new = [item for item in manager.valid_backups() if item['operation'] == 'upgrade']
        self.assertEqual(len(new), 1)
        self.assertNotEqual(new[0]['id'], incomplete.name)

    def test_plan_is_pure_redacted_and_uses_no_controller(self):
        code, output = self.invoke(self.setup_args('plan') + ['--json'])
        self.assertEqual(code, 0); self.assertEqual(self.ctl.calls, []); self.assertEqual(self.subprocess_calls, [])
        self.assertFalse((self.config_path.parent / 'backups').exists())
        value = json.loads(output)
        self.assertEqual(value['operation'], 'setup')
        self.assertNotIn('token', output); self.assertNotIn('fixture', output.split('voice')[0])

    def test_uninstall_plan_complete_partial_unknown_and_conflicts(self):
        self.units.mkdir(parents=True); self.app.mkdir(parents=True)
        for name, command in ((manager.SERVICE, 'run'), (manager.CACHE, 'cache')):
            (self.units / name).write_text(manager.unit_text(command, 'test'))
        for name in manager.OWNED_APP_FILES - {manager.OWNERSHIP_FILE}: (self.app / name).write_text('owned')
        (self.app / manager.OWNERSHIP_FILE).write_text(json.dumps({
            'schema': 1, 'project': manager.APP_NAME, 'version': manager.VERSION,
            'files': sorted(manager.OWNED_APP_FILES),
        }))
        (self.app / 'keep.txt').write_text('unknown')
        launcher = self.home / '.local/bin/novel-tts'; launcher.parent.mkdir(parents=True)
        launcher.write_text('#!/bin/sh\nexec /usr/bin/python3 ' + str(self.app / 'novel_tts.py') + ' "$@"\n')
        plan = manager.uninstall_plan()
        self.assertIn(manager.SERVICE, plan['planned_removals']); self.assertIn('app/keep.txt', plan['preserved'])
        self.assertEqual(plan['removed'], []); self.assertIsNone(plan['snapshot_id']); self.assertEqual(self.ctl.calls, [])
        (self.units / manager.SERVICE).write_text('foreign')
        self.assertIn(manager.SERVICE, manager.uninstall_plan()['conflicts'])

    def test_uninstall_dry_run_is_json_pure_and_noninteractive_requires_yes(self):
        code, output = self.invoke(['uninstall', '--dry-run', '--json'])
        self.assertEqual(code, 0); value = json.loads(output); self.assertEqual(value['removed'], []); self.assertIsNone(value['snapshot_id'])
        with self.assertRaisesRegex(ValueError, '--yes'): self.invoke(['uninstall'])
        self.assertEqual(self.ctl.calls, []); self.assertEqual(self.subprocess_calls, [])

    def test_setup_dry_run_equals_plan_and_noninteractive_requires_yes(self):
        _, plan = self.invoke(self.setup_args('plan') + ['--json'])
        _, dry_run = self.invoke(self.setup_args() + ['--dry-run', '--json'])
        self.assertEqual(json.loads(plan), json.loads(dry_run))
        with self.assertRaisesRegex(ValueError, '--yes'): self.invoke(self.setup_args())
        self.assertEqual(self.ctl.calls, [])

    def test_setup_yes_uses_fake_transaction_and_legacy_install_alias(self):
        code, _ = self.invoke(self.setup_args() + ['--yes'])
        self.assertEqual(code, 0); self.assertIn(('stop', manager.CACHE, manager.SERVICE), self.ctl.calls)
        self.assertTrue(self.config_path.exists())
        self.ctl.calls.clear()
        code, _ = self.invoke(self.setup_args('install') + ['--dry-run', '--json'])
        self.assertEqual(code, 0); self.assertEqual(self.ctl.calls, [])

    def test_backup_listing_ignores_incomplete_snapshots(self):
        self.invoke(self.setup_args() + ['--yes'])
        self.ctl.calls.clear()
        with patch.object(manager, 'read_config', return_value=json.loads(self.config_path.read_text())):
            code, output = self.invoke(['backup', '--json'])
        self.assertEqual(code, 0); self.assertFalse(any(call[0] == 'stop' for call in self.ctl.calls))
        (self.config_path.parent / 'backups/incomplete').mkdir()
        _, listing = self.invoke(['backups', '--json'])
        values = json.loads(listing)
        self.assertTrue(values); self.assertNotIn('incomplete', [item['id'] for item in values])

    def test_restore_rejects_bad_identifier_before_controller(self):
        with self.assertRaisesRegex(ValueError, 'explícito'): self.invoke(['restore'])
        with self.assertRaisesRegex(ValueError, 'Identificador'): self.invoke(['restore', '--backup-id', '../bad', '--yes'])
        self.assertEqual(self.ctl.calls, [])

    def test_upgrade_schema_3_is_idempotent_and_doctor_json_is_redacted_read_only(self):
        config = manager.build_config(qwen_root=self.qwen, model=self.assets[0], codec=self.assets[1], voice_name='fixture', voice_spk=self.assets[2], voice_rvq=self.assets[3], voice_text=self.assets[4], cache_dir=self.root / 'cache')
        transaction = manager.InstallTransaction(config, ctl=self.ctl, ready=lambda _: None,
            source_dir=Path(manager.__file__).resolve().parent, clock=self.clock)
        transaction.run()
        self.ctl.calls.clear()
        with patch.object(manager, 'read_config', return_value=config):
            code, output = self.invoke(['upgrade', '--json'])
        self.assertEqual(code, 0); self.assertTrue(json.loads(output)['idempotent'])
        self.assertEqual(self.ctl.calls, [])
        with patch.object(manager, 'read_config', return_value=config), patch.object(
                manager, 'doctor_report', return_value={
                    'code': 0, 'healthy': True, 'message': 'Saudável',
                    'services': {manager.SERVICE: True, manager.CACHE: True}, 'upstream_port': 8080,
                }):
            code, output = self.invoke(['doctor', '--json'])
        self.assertEqual(code, 0); self.assertNotIn(config['token'], output)
        self.assertNotIn(str(self.assets[4]), output); self.assertNotIn(str(config['cache_dir']), output)

    def test_schema3_upgrade_compares_installed_package_bytes_and_preserves_all_config(self):
        config = self.schema3_fixture()
        self.seed_package_install(config, 'installed-1.4')
        original_config = self.config_path.read_bytes()
        old_app = {name: (self.app / name).read_bytes()
                   for name in ('novel_tts.py', 'nlr_config.py', 'companion_server.py')}
        self.ctl.calls.clear()
        with patch.object(manager, 'read_config', return_value=config):
            code, output = self.invoke(['upgrade', '--dry-run', '--json'])
        plan = json.loads(output)
        self.assertEqual(code, 0)
        self.assertFalse(plan.get('idempotent', False))
        self.assertIn('application', plan['changes'])
        self.assertNotIn(config['token'], output)
        self.assertNotIn(str(self.root), output)
        self.assertEqual(self.config_path.read_bytes(), original_config)
        self.assertEqual(self.ctl.calls, [])

        with patch.object(manager, 'read_config', return_value=config):
            code, output = self.invoke(['upgrade', '--yes', '--json'])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(self.config_path.read_text()), config)
        self.assertTrue(any((self.app / name).read_bytes() != old_app[name] for name in old_app))
        self.assertEqual(self.ctl.active, {manager.SERVICE: True, manager.CACHE: True})
        self.assertEqual(self.ctl.enabled, {manager.SERVICE: True, manager.CACHE: True})
        self.assertEqual(self.subprocess_calls, [])

        self.ctl.calls.clear()
        with patch.object(manager, 'read_config', return_value=config):
            code, output = self.invoke(['upgrade', '--dry-run', '--json'])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(output)['idempotent'])
        self.assertEqual(self.ctl.calls, [])

    def test_upgrade_refuses_partial_and_adulterated_package_markers(self):
        config = self.schema3_fixture()
        self.config_path.parent.mkdir(parents=True)
        self.config_path.write_text(json.dumps(config))
        self.app.mkdir(parents=True)
        (self.app / 'novel_tts.py').write_text('partial old package')
        with patch.object(manager, 'read_config', return_value=config):
            code, plan_text = self.invoke(['upgrade', '--dry-run', '--json'])
        self.assertEqual(code, 0)
        self.assertFalse(json.loads(plan_text)['idempotent'])
        self.assertIn('application', json.loads(plan_text)['changes'])
        self.ctl.calls.clear()
        with patch.object(manager, 'read_config', return_value=config):
            with self.assertRaises(manager.TransactionFailure):
                self.invoke(['upgrade', '--yes', '--json'], ready=lambda _: None)
        self.assertFalse(any(call[0] == 'stop' for call in self.ctl.calls))
        shutil.rmtree(self.app)
        with patch.object(manager, 'validate', lambda _config: None):
            self.seed_package_install(config, 'complete-package')
        marker_path = self.app / manager.OWNERSHIP_FILE
        marker = json.loads(marker_path.read_text())
        self.assertEqual(marker['version'], manager.VERSION)

        marker['version'] = '77.0.0'
        marker_path.write_text(json.dumps(marker))
        self.ctl.calls.clear()
        with patch.object(manager, 'read_config', return_value=config):
            code, plan_text = self.invoke(['upgrade', '--dry-run', '--json'])
        self.assertEqual(code, 0)
        self.assertFalse(json.loads(plan_text)['idempotent'])
        self.assertIn('application', json.loads(plan_text)['changes'])
        self.assertNotIn(config['token'], plan_text)
        self.assertNotIn(str(self.root), plan_text)
        self.ctl.calls.clear()
        with patch.object(manager, 'read_config', return_value=config):
            with self.assertRaises(manager.TransactionFailure):
                self.invoke(['upgrade', '--yes', '--json'], ready=lambda _: None)
        self.assertFalse(any(call[0] == 'stop' for call in self.ctl.calls))
        self.assertEqual(json.loads(marker_path.read_text())['version'], '77.0.0')

    def test_upgrade_without_existing_configuration_fails_without_creating_installation(self):
        with self.assertRaises(FileNotFoundError):
            self.invoke(['upgrade', '--yes', '--json'])
        self.assertFalse(self.config_path.exists())
        self.assertFalse(self.app.exists())
        self.assertEqual(self.ctl.calls, [])
        self.assertEqual(self.subprocess_calls, [])

    def test_1_4_install_upgrades_to_1_5_and_explicit_restore_preserves_bytes_config_and_states(self):
        config = self.schema3_fixture()
        old_source = self.root / 'package-1.4.0'
        old_source.mkdir()
        old_contents = {}
        for name in manager.PACKAGE_FILES:
            data = f'legacy 1.4.0 package module: {name}\n'.encode()
            (old_source / name).write_bytes(data)
            old_contents[name] = data
        old_install = manager.InstallTransaction(config, ctl=self.ctl, ready=lambda _: None,
            source_dir=old_source, clock=self.clock)
        old_install.run()
        ownership_path = self.app / manager.OWNERSHIP_FILE
        ownership = json.loads(ownership_path.read_text())
        old_hashes = {name: hashlib.sha256(data).hexdigest()
                      for name, data in old_contents.items()}
        ownership['version'] = '1.4.0'
        ownership['package_files_sha256'] = old_hashes
        ownership['package_fingerprint'] = hashlib.sha256(json.dumps(
            {'version': '1.4.0', 'files': old_hashes}, sort_keys=True,
            separators=(',', ':')).encode()).hexdigest()
        ownership_path.write_text(json.dumps(ownership, sort_keys=True))

        self.ctl.active = {manager.SERVICE: False, manager.CACHE: True}
        self.ctl.enabled = {manager.SERVICE: False, manager.CACHE: True}
        original_config = self.config_path.read_bytes()
        original_app = {name: (self.app / name).read_bytes()
                        for name in (*manager.PACKAGE_FILES, manager.OWNERSHIP_FILE)}
        original_units = {name: (self.units / name).read_bytes()
                          for name in (manager.SERVICE, manager.CACHE)}
        original_launcher = (self.home / '.local/bin/novel-tts').read_bytes()
        snapshot = manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        metadata_path = snapshot / 'snapshot.json'
        metadata = json.loads(metadata_path.read_text())
        metadata['version'] = '1.4.0'
        metadata_path.write_text(json.dumps(metadata))
        self.assertEqual(manager.validated_backup(snapshot.name)[0], snapshot)

        self.ctl.active = {manager.SERVICE: True, manager.CACHE: True}
        self.ctl.enabled = {manager.SERVICE: True, manager.CACHE: True}
        self.ctl.calls.clear()
        with patch.object(manager, 'read_config', return_value=config):
            code, output = self.invoke(['upgrade', '--dry-run', '--json'])
        plan = json.loads(output)
        self.assertEqual(code, 0)
        self.assertFalse(plan['idempotent'])
        self.assertIn('application', plan['changes'])
        self.assertNotIn(config['token'], output)
        self.assertNotIn(str(self.root), output)
        self.assertEqual(self.ctl.calls, [])

        with patch.object(manager, 'read_config', return_value=config):
            code, _ = self.invoke(['upgrade', '--yes', '--json'], ready=lambda _: None)
        self.assertEqual(code, 0)
        self.assertEqual(self.config_path.read_bytes(), original_config)
        for name in manager.PACKAGE_FILES:
            self.assertEqual((self.app / name).read_bytes(), (Path(manager.__file__).parent / name).read_bytes())
        self.assertEqual(json.loads(ownership_path.read_text())['version'], manager.VERSION)
        self.ctl.calls.clear()
        with patch.object(manager, 'read_config', return_value=config):
            code, output = self.invoke(['upgrade', '--dry-run', '--json'])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(output)['idempotent'])
        self.assertEqual(self.ctl.calls, [])

        with patch.object(manager, 'read_config', return_value=config):
            code, _ = self.invoke(['restore', '--backup-id', snapshot.name, '--yes', '--json'],
                                  ready=lambda _: self.fail('inactive snapshot must not await readiness'))
        self.assertEqual(code, 0)
        self.assertEqual(self.config_path.read_bytes(), original_config)
        self.assertEqual({name: (self.app / name).read_bytes() for name in original_app}, original_app)
        self.assertEqual({name: (self.units / name).read_bytes() for name in original_units}, original_units)
        self.assertEqual((self.home / '.local/bin/novel-tts').read_bytes(), original_launcher)
        self.assertEqual(self.ctl.active, {manager.SERVICE: False, manager.CACHE: True})
        self.assertEqual(self.ctl.enabled, {manager.SERVICE: False, manager.CACHE: True})
        self.assertEqual(self.subprocess_calls, [])

    def seed_internal_1_5_0_install(self, config):
        """An install as the internal 1.5.0 build left it: old marker, old unit text."""
        source = self.root / 'package-1.5.0'
        source.mkdir()
        contents = {name: f'internal 1.5.0 module: {name}\n'.encode() for name in manager.PACKAGE_FILES}
        for name, data in contents.items():
            (source / name).write_bytes(data)
        manager.InstallTransaction(config, ctl=self.ctl, ready=lambda _: None,
                                   source_dir=source, clock=self.clock).run()
        marker_path = self.app / manager.OWNERSHIP_FILE
        marker = json.loads(marker_path.read_text())
        hashes = {name: hashlib.sha256(data).hexdigest() for name, data in contents.items()}
        marker['version'] = '1.5.0'
        marker['package_files_sha256'] = hashes
        marker['package_fingerprint'] = hashlib.sha256(json.dumps(
            {'version': '1.5.0', 'files': hashes}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        marker_path.write_text(json.dumps(marker, sort_keys=True))
        for name in (manager.SERVICE, manager.CACHE):  # units as 1.5.0 generated them
            unit = self.units / name
            text = unit.read_text().replace('Novel TTS', 'Novel Local Reader')
            unit.write_text(re.sub(r'ReadWritePaths="-(.*)"', r'ReadWritePaths=-\1', text))
        return contents

    def test_internal_1_5_0_install_upgrades_end_to_end_and_its_snapshot_restores(self):
        config = self.schema3_fixture()
        old_contents = self.seed_internal_1_5_0_install(config)
        original_config = self.config_path.read_bytes()
        original_app = {name: (self.app / name).read_bytes()
                        for name in (*manager.PACKAGE_FILES, manager.OWNERSHIP_FILE)}
        original_units = {name: (self.units / name).read_bytes() for name in (manager.SERVICE, manager.CACHE)}
        self.assertIn(b'Novel Local Reader', original_units[manager.SERVICE])
        self.ctl.active = {manager.SERVICE: False, manager.CACHE: True}
        self.ctl.enabled = {manager.SERVICE: False, manager.CACHE: True}

        self.ctl.calls.clear()
        with patch.object(manager, 'read_config', return_value=config):
            code, output = self.invoke(['upgrade', '--dry-run', '--json'])
        plan = json.loads(output)
        self.assertEqual(code, 0)
        self.assertFalse(plan['idempotent'])
        self.assertIn('application', plan['changes'])
        self.assertIn('systemd_units', plan['changes'])
        self.assertEqual(self.ctl.calls, [])

        with patch.object(manager, 'read_config', return_value=config):
            code, output = self.invoke(['upgrade', '--yes', '--json'], ready=lambda _: None)
        self.assertEqual(code, 0)
        snapshot_id = json.loads(output)['backup_id']
        for name in manager.PACKAGE_FILES:
            self.assertEqual((self.app / name).read_bytes(), (Path(manager.__file__).parent / name).read_bytes())
        self.assertEqual(json.loads((self.app / manager.OWNERSHIP_FILE).read_text())['version'], manager.VERSION)
        unit_text = (self.units / manager.CACHE).read_text()
        self.assertIn('Description=Novel TTS', unit_text)
        self.assertRegex(unit_text, r'ReadWritePaths="-')
        with patch.object(manager, 'read_config', return_value=config):
            code, output = self.invoke(['upgrade', '--dry-run', '--json'])
        self.assertTrue(json.loads(output)['idempotent'])

        # The snapshot taken by the upgrade carries the 1.5.0 bytes and restores them exactly.
        saved = json.loads((manager.backup_root() / snapshot_id / 'app' / manager.OWNERSHIP_FILE).read_text())
        self.assertEqual(saved['version'], '1.5.0')
        with patch.object(manager, 'read_config', return_value=config):
            code, _ = self.invoke(['restore', '--backup-id', snapshot_id, '--yes', '--json'],
                                  ready=lambda _: self.fail('inactive service must not await readiness'))
        self.assertEqual(code, 0)
        self.assertEqual(self.config_path.read_bytes(), original_config)
        self.assertEqual({name: (self.app / name).read_bytes() for name in original_app}, original_app)
        self.assertEqual({name: (self.units / name).read_bytes() for name in original_units}, original_units)
        self.assertEqual({name: (self.app / name).read_bytes() for name in manager.PACKAGE_FILES}, old_contents)
        self.assertEqual(self.ctl.active, {manager.SERVICE: False, manager.CACHE: True})

    def test_snapshot_written_by_the_internal_1_5_0_build_is_restorable(self):
        config = self.schema3_fixture()
        self.seed_internal_1_5_0_install(config)
        original_app = {name: (self.app / name).read_bytes()
                        for name in (*manager.PACKAGE_FILES, manager.OWNERSHIP_FILE)}
        snapshot = manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        metadata_path = snapshot / 'snapshot.json'
        metadata = json.loads(metadata_path.read_text())
        metadata['version'] = '1.5.0'  # what the internal build stamped
        metadata_path.write_text(json.dumps(metadata))
        self.assertEqual(manager.validated_backup(snapshot.name)[0], snapshot)
        shutil.rmtree(self.app)
        with patch.object(manager, 'read_config', return_value=config):
            code, _ = self.invoke(['restore', '--backup-id', snapshot.name, '--yes', '--json'])
        self.assertEqual(code, 0)
        self.assertEqual({name: (self.app / name).read_bytes() for name in original_app}, original_app)

    def test_legacy_ownership_evidence_is_accepted_for_internal_1_5_0_snapshots_only(self):
        config = self.schema3_fixture()
        config['schema'] = 2
        with patch.object(manager, 'validate', lambda _config: None):
            self.seed_package_install(config, 'known-pre-manifest')
        (self.app / manager.OWNERSHIP_FILE).unlink()
        old_app = {name: (self.app / name).read_bytes() for name in manager.PACKAGE_FILES}
        digests = tuple(hashlib.sha256(old_app[name]).hexdigest() for name in manager.PACKAGE_FILES)
        self.ctl.active = {manager.SERVICE: False, manager.CACHE: False}
        with patch.object(manager, 'LEGACY_APP_DIGESTS', frozenset({digests})), \
                patch.object(manager, 'validate', lambda _config: None):
            self.invoke(['upgrade', '--yes', '--json'], ready=lambda _: self.fail('unexpected readiness'))
            snapshot = next(item['path'] for item in manager.valid_backups() if item['operation'] == 'upgrade')
            metadata_path = snapshot / 'snapshot.json'
            metadata = json.loads(metadata_path.read_text())
            for version, accepted in (('1.5.0', True), (manager.VERSION, True), ('1.4.0', False)):
                with self.subTest(version=version):
                    metadata['version'] = version
                    metadata_path.write_text(json.dumps(metadata))
                    if accepted:
                        self.assertEqual(manager.validated_backup(snapshot.name)[0], snapshot)
                    else:
                        with self.assertRaisesRegex(ValueError, 'legada incompatível'):
                            manager.validated_backup(snapshot.name)

    def test_snapshot_versions_outside_the_compatibility_matrix_are_rejected(self):
        config = self.seed_real_owned_application()
        snapshot = manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        metadata_path = snapshot / 'snapshot.json'
        original = json.loads(metadata_path.read_text())
        for version, snapshot_format in (('2.0.0', 1), ('1.5.0', None), (manager.VERSION, None), ('1.4.0', 2)):
            with self.subTest(version=version, snapshot_format=snapshot_format):
                metadata = dict(original, version=version)
                metadata.pop('snapshot_format', None)
                if snapshot_format is not None:
                    metadata['snapshot_format'] = snapshot_format
                metadata_path.write_text(json.dumps(metadata))
                with self.assertRaisesRegex(ValueError, 'incompat'):
                    manager.validated_backup(snapshot.name)

    def test_legacy_1_4_snapshot_without_checksums_is_still_explicitly_restorable(self):
        config = self.schema3_fixture()
        self.seed_package_install(config, 'legacy-1.4-snapshot')
        self.ctl.active = {manager.SERVICE: False, manager.CACHE: False}
        self.ctl.enabled = {manager.SERVICE: False, manager.CACHE: False}
        snapshot = manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        metadata_path = snapshot / 'snapshot.json'
        metadata = json.loads(metadata_path.read_text())
        metadata['version'] = '1.4.0'
        metadata.pop('snapshot_format')
        metadata.pop('checksums')
        metadata_path.write_text(json.dumps(metadata))
        self.assertEqual(manager.validated_backup(snapshot.name)[0], snapshot)

        self.seed_package_install(config, 'replacement-1.5-package')
        self.ctl.active = {manager.SERVICE: True, manager.CACHE: True}
        self.ctl.enabled = {manager.SERVICE: True, manager.CACHE: True}
        with patch.object(manager, 'read_config', return_value=config):
            code, _ = self.invoke(['restore', '--backup-id', snapshot.name, '--yes', '--json'],
                                  ready=lambda _: None)
        self.assertEqual(code, 0)
        self.assertEqual(self.config_path.read_bytes(), (snapshot / 'config.json').read_bytes())
        self.assertEqual((self.app / 'novel_tts.py').read_bytes(),
                         (snapshot / 'app/novel_tts.py').read_bytes())
        self.assertEqual(self.ctl.active, {manager.SERVICE: False, manager.CACHE: False})
        self.assertEqual(self.ctl.enabled, {manager.SERVICE: False, manager.CACHE: False})

    def test_v14_upgrade_failure_recovers_files_configuration_and_individual_unit_states(self):
        config = self.schema3_fixture()
        self.seed_package_install(config, 'v14-before-failing-upgrade')
        marker_path = self.app / manager.OWNERSHIP_FILE
        marker = json.loads(marker_path.read_text())
        marker['version'] = '1.4.0'
        marker['package_fingerprint'] = hashlib.sha256(json.dumps(
            {'version': '1.4.0', 'files': marker['package_files_sha256']},
            sort_keys=True, separators=(',', ':')
        ).encode()).hexdigest()
        marker_path.write_text(json.dumps(marker))
        self.ctl.active = {manager.SERVICE: False, manager.CACHE: True}
        self.ctl.enabled = {manager.SERVICE: True, manager.CACHE: False}
        before_config = self.config_path.read_bytes()
        before_app = {name: (self.app / name).read_bytes()
                      for name in (*manager.PACKAGE_FILES, manager.OWNERSHIP_FILE)}
        before_units = {name: (self.units / name).read_bytes()
                        for name in (manager.SERVICE, manager.CACHE)}
        before_launcher = (self.home / '.local/bin/novel-tts').read_bytes()

        real_controller = self.ctl
        class FailFirstReload:
            failed = False

            def __getattr__(self, name):
                return getattr(real_controller, name)

            def __call__(self, *args, **kwargs):
                if args[0] == 'daemon-reload' and not self.failed:
                    self.failed = True
                    raise RuntimeError('injected daemon reload failure')
                return real_controller(*args, **kwargs)

        self.ctl = FailFirstReload()

        with patch.object(manager, 'read_config', return_value=config):
            with self.assertRaises(manager.TransactionFailure) as raised:
                self.invoke(['upgrade', '--yes', '--json'], ready=Mock())
        self.assertIn('injected daemon reload failure', str(raised.exception.original))
        self.assertEqual(raised.exception.stage, 'daemon_reload')
        self.assertEqual(raised.exception.code, 'NLR_UPGRADE_RELOAD_FAILED')
        self.assertEqual(raised.exception.rollback_status, 'complete')
        diagnostic = json.dumps(manager.cli_failure_record(raised.exception))
        self.assertNotIn('injected daemon reload failure', diagnostic)
        self.assertEqual(self.config_path.read_bytes(), before_config)
        self.assertEqual({name: (self.app / name).read_bytes() for name in before_app}, before_app)
        self.assertEqual({name: (self.units / name).read_bytes() for name in before_units}, before_units)
        self.assertEqual((self.home / '.local/bin/novel-tts').read_bytes(), before_launcher)
        self.assertEqual(self.ctl.active, {manager.SERVICE: False, manager.CACHE: True})
        self.assertEqual(self.ctl.enabled, {manager.SERVICE: True, manager.CACHE: False})

    def test_restore_rejects_incompatible_snapshot_version_and_bad_checksums_before_controller(self):
        config = self.schema3_fixture()
        self.seed_package_install(config, 'installed-1.4')
        snapshot = manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        self.assertEqual(manager.validated_backup(snapshot.name)[0], snapshot)
        metadata_file = snapshot / 'snapshot.json'
        metadata = json.loads(metadata_file.read_text())
        self.assertEqual((metadata['version'], metadata['snapshot_format']),
                         (manager.VERSION, manager.SNAPSHOT_FORMAT))
        self.assertEqual(metadata['checksums'], manager._snapshot_checksums(snapshot))

        metadata['version'] = '1.4.0'
        metadata_file.write_text(json.dumps(metadata))
        self.assertEqual(manager.validated_backup(snapshot.name)[0], snapshot)
        metadata.pop('snapshot_format')
        metadata.pop('checksums')
        metadata_file.write_text(json.dumps(metadata))
        self.assertEqual(manager.validated_backup(snapshot.name)[0], snapshot)

        metadata['version'] = '9.9.9'
        metadata_file.write_text(json.dumps(metadata))
        self.ctl.calls.clear()
        with self.assertRaisesRegex(ValueError, 'incompatível'):
            manager.validated_backup(snapshot.name)
        self.assertEqual(self.ctl.calls, [])

        metadata['version'] = '1.4.0'
        metadata['snapshot_format'] = manager.SNAPSHOT_FORMAT + 1
        metadata['checksums'] = manager._snapshot_checksums(snapshot)
        metadata_file.write_text(json.dumps(metadata))
        with self.assertRaisesRegex(ValueError, 'incompatível'):
            manager.validated_backup(snapshot.name)

        metadata['snapshot_format'] = manager.SNAPSHOT_FORMAT
        metadata['checksums'] = manager._snapshot_checksums(snapshot)
        metadata_file.write_text(json.dumps(metadata))
        target = snapshot / 'config.json'
        target.write_bytes(target.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'checksum|integridade'):
            manager.validated_backup(snapshot.name)
        self.assertEqual(self.ctl.calls, [])

    def test_restore_service_failure_recovers_pre_restore_files_and_states(self):
        config = self.schema3_fixture()
        self.seed_package_install(config, 'snapshot-package')
        snapshot = manager.create_backup(config, ctl=self.ctl, clock=self.clock)
        self.seed_package_install(config, 'current-package')
        current_app = {name: (self.app / name).read_bytes()
                       for name in ('novel_tts.py', 'nlr_config.py', 'companion_server.py')}
        underlying = self.ctl
        failed = {'value': False}

        def fail_first_start(*args, **kwargs):
            result = underlying(*args, **kwargs)
            if args[0] == 'start' and not failed['value']:
                failed['value'] = True
                raise RuntimeError('injected restore start failure')
            return result

        with self.assertRaises(manager.TransactionFailure) as raised:
            manager.transactional_restore(
                snapshot.name, config, ctl=fail_first_start, ready=lambda _: None,
                source_dir=Path(manager.__file__).resolve().parent, clock=self.clock,
            )
        self.assertIn('injected restore start failure', str(raised.exception.original))
        self.assertIsNone(raised.exception.rollback_error)
        self.assertEqual({name: (self.app / name).read_bytes() for name in current_app}, current_app)
        self.assertEqual(self.ctl.active, {manager.SERVICE: True, manager.CACHE: True})
        self.assertEqual(self.ctl.enabled, {manager.SERVICE: True, manager.CACHE: True})
        self.assertEqual(self.subprocess_calls, [])

    def test_upgrade_schema_2_writes_schema_3_and_keeps_token(self):
        config = manager.build_config(qwen_root=self.qwen, model=self.assets[0], codec=self.assets[1], voice_name='fixture', voice_spk=self.assets[2], voice_rvq=self.assets[3], voice_text=self.assets[4], cache_dir=self.root / 'cache')
        config['schema'] = 2
        config['profiles']['qwen']['argv'].extend(['--preserved-custom-flag', 'preserved-value'])
        config['profiles']['qwen']['voices']['second-voice'] = {
            'spk': str(self.assets[2]), 'rvq': str(self.assets[3]), 'text': str(self.assets[4])
        }
        config['profiles']['alternate'] = {
            'backend': 'qwen3', 'cwd': str(self.qwen), 'argv': ['/custom/server', '--custom', 'yes'],
            'voices': {'third-voice': {'spk': 'third.spk', 'rvq': 'third.rvq', 'text': 'third.txt'}},
        }
        config['custom_profile_metadata'] = {'preserve': True}
        with patch.object(manager, 'validate', lambda value: value):
            self.seed_package_install(config, 'schema2-package')
        expected = json.loads(json.dumps(config))
        expected['schema'] = 3
        expected['require_mount'] = True
        with patch.object(manager, 'read_config', return_value=config), patch.object(manager, 'validate', lambda value: value):
            code, _ = self.invoke(['upgrade', '--yes', '--json'])
        migrated = json.loads(self.config_path.read_text())
        self.assertEqual(code, 0); self.assertEqual(migrated, expected)

    def test_upgrade_snapshot_records_saved_schema_and_upgrade_operation(self):
        config = self.schema3_fixture()
        config['schema'] = 2
        with patch.object(manager, 'validate', lambda _config: None):
            self.seed_package_install(config, 'installed-before-upgrade')
        marker_path = self.app / manager.OWNERSHIP_FILE
        marker = json.loads(marker_path.read_text())
        marker['version'] = '1.4.0'
        marker['package_fingerprint'] = hashlib.sha256(json.dumps(
            {'version': '1.4.0', 'files': marker['package_files_sha256']},
            sort_keys=True, separators=(',', ':')
        ).encode()).hexdigest()
        marker_path.write_text(json.dumps(marker))
        previous_config = self.config_path.read_bytes()

        with patch.object(manager, 'validate', lambda _config: None):
            code, _ = self.invoke(['upgrade', '--yes', '--json'], ready=lambda _: None)

        self.assertEqual(code, 0)
        snapshots = sorted(
            (path for path in (self.config_path.parent / 'backups').iterdir()
             if (path / 'snapshot-ready').is_file()),
            key=lambda path: path.name,
        )
        upgrade_snapshot = snapshots[-1]
        metadata = json.loads((upgrade_snapshot / 'snapshot.json').read_text())
        saved_config = json.loads((upgrade_snapshot / 'config.json').read_text())
        self.assertEqual(previous_config, (upgrade_snapshot / 'config.json').read_bytes())
        self.assertEqual(metadata['operation'], 'upgrade')
        self.assertEqual(metadata['schema'], 2)
        self.assertEqual(saved_config['schema'], 2)
        with patch.object(manager, 'validate', lambda _config: None):
            self.assertEqual(manager.validated_backup(upgrade_snapshot.name)[0], upgrade_snapshot)

    def test_pre_manifest_upgrade_snapshot_is_validated_and_restorable(self):
        config = self.schema3_fixture()
        config['schema'] = 2
        with patch.object(manager, 'validate', lambda _config: None):
            self.seed_package_install(config, 'known-pre-manifest')
        (self.app / manager.OWNERSHIP_FILE).unlink()
        old_app = {name: (self.app / name).read_bytes() for name in manager.PACKAGE_FILES}
        old_config = self.config_path.read_bytes()
        digests = tuple(hashlib.sha256(old_app[name]).hexdigest() for name in manager.PACKAGE_FILES)
        self.ctl.active = {manager.SERVICE: False, manager.CACHE: False}
        self.ctl.enabled = {manager.SERVICE: False, manager.CACHE: True}
        with patch.object(manager, 'LEGACY_APP_DIGESTS', frozenset({digests})), \
                patch.object(manager, 'validate', lambda _config: None):
            code, _ = self.invoke(['upgrade', '--yes', '--json'], ready=lambda _: self.fail('unexpected readiness'))
            self.assertEqual(code, 0)
            snapshot = next(item['path'] for item in manager.valid_backups() if item['operation'] == 'upgrade')
            self.assertEqual(manager.validated_backup(snapshot.name)[0], snapshot)
            self.assertTrue((self.app / manager.OWNERSHIP_FILE).exists())
            self.assertTrue((snapshot / 'legacy-ownership.json').is_file())
            self.assertFalse((snapshot / 'app' / manager.OWNERSHIP_FILE).exists())
            self.assertEqual((snapshot / 'config.json').read_bytes(), old_config)
            self.assertEqual({name: (snapshot / 'app' / name).read_bytes() for name in manager.PACKAGE_FILES}, old_app)
            self.assertEqual(json.loads((snapshot / 'states.json').read_text()), {
                manager.SERVICE: {'active': False, 'enabled': False},
                manager.CACHE: {'active': False, 'enabled': True},
            })
            self.invoke(['restore', '--backup-id', snapshot.name, '--yes', '--json'],
                        ready=lambda _: self.fail('unexpected readiness'))
        self.assertEqual(self.config_path.read_bytes(), old_config)
        self.assertEqual({name: (self.app / name).read_bytes() for name in manager.PACKAGE_FILES}, old_app)
        self.assertFalse((self.app / manager.OWNERSHIP_FILE).exists())
        self.assertEqual(self.ctl.active, {manager.SERVICE: False, manager.CACHE: False})
        self.assertEqual(self.ctl.enabled, {manager.SERVICE: False, manager.CACHE: True})
        # Even a rewritten checksum table cannot make altered application
        # bytes agree with the ownership evidence in the snapshot.
        app_module = snapshot / 'app' / manager.PACKAGE_FILES[0]
        app_module.write_bytes(app_module.read_bytes() + b'altered')
        metadata_path = snapshot / 'snapshot.json'
        metadata = json.loads(metadata_path.read_text())
        metadata['checksums'] = manager._snapshot_checksums(snapshot)
        metadata_path.write_text(json.dumps(metadata))
        self.ctl.calls.clear()
        with patch.object(manager, 'validate', lambda _config: None):
            with self.assertRaisesRegex(ValueError, 'pacote conhecido|integridade|snapshot'):
                manager.validated_backup(snapshot.name)
        self.assertEqual(self.ctl.calls, [])

    def test_legacy_package_allowlist_contains_only_complete_sha256_tuples(self):
        self.assertEqual(len(manager.LEGACY_APP_DIGESTS), 2)
        self.assertTrue(all(len(digest) == 64 and all(c in '0123456789abcdef' for c in digest)
                            for package in manager.LEGACY_APP_DIGESTS for digest in package))

    def test_pre_manifest_upgrade_rejects_changed_missing_and_extra_files_before_mutation(self):
        config = self.schema3_fixture()
        config['schema'] = 2
        with patch.object(manager, 'validate', lambda _config: None):
            self.seed_package_install(config, 'known-pre-manifest')
        (self.app / manager.OWNERSHIP_FILE).unlink()
        originals = {name: (self.app / name).read_bytes() for name in manager.PACKAGE_FILES}
        digests = tuple(hashlib.sha256(originals[name]).hexdigest() for name in manager.PACKAGE_FILES)
        original_backups = {item['id'] for item in manager.valid_backups()}
        for case in ('changed', 'missing', 'extra'):
            for name, data in originals.items(): (self.app / name).write_bytes(data)
            extra = self.app / 'unexpected.py'
            extra.unlink(missing_ok=True)
            if case == 'changed': (self.app / manager.PACKAGE_FILES[0]).write_bytes(b'adulterated')
            elif case == 'missing': (self.app / manager.PACKAGE_FILES[0]).unlink()
            else: extra.write_bytes(b'unexpected')
            self.ctl.calls.clear()
            with patch.object(manager, 'LEGACY_APP_DIGESTS', frozenset({digests})), \
                    patch.object(manager, 'validate', lambda _config: None):
                with self.assertRaises(manager.TransactionFailure) as raised:
                    self.invoke(['upgrade', '--yes', '--json'])
                self.assertEqual(raised.exception.rollback_status, 'not-needed')
            self.assertFalse(any(call[0] in ('stop', 'start', 'enable', 'disable') for call in self.ctl.calls))
            self.assertEqual({item['id'] for item in manager.valid_backups()}, original_backups)

    def test_upgrade_cli_preserves_stopped_disabled_units_without_claiming_readiness(self):
        config = self.schema3_fixture()
        config['schema'] = 2
        self.seed_package_install(config, 'old-disabled-upgrade')
        self.ctl.calls.clear()
        self.ctl.active = {manager.SERVICE: False, manager.CACHE: False}
        self.ctl.enabled = {manager.SERVICE: False, manager.CACHE: False}
        ready = Mock()

        with patch.object(manager, 'validate', lambda _config: None):
            code, output = self.invoke(['upgrade', '--yes', '--json'], ready=ready)

        self.assertEqual(code, 0)
        result = json.loads(output)
        self.assertEqual(result['operation'], 'upgrade')
        self.assertEqual(result['schema'], 3)
        self.assertEqual(result['migration'], {'from_schema': 2, 'to_schema': 3})
        self.assertNotIn('readiness', result)
        self.assertNotIn('synthesis', result)
        self.assertFalse(any(call[0] in ('enable', 'start') for call in self.ctl.calls))
        self.assertEqual(self.ctl.active, {manager.SERVICE: False, manager.CACHE: False})
        self.assertEqual(self.ctl.enabled, {manager.SERVICE: False, manager.CACHE: False})
        ready.assert_not_called()

    def test_incompatible_existing_snapshot_is_not_consumed_by_upgrade_transaction(self):
        config = self.schema3_fixture()
        self.seed_package_install(config, 'preexisting-install')
        backup_root = self.config_path.parent / 'backups'
        invalid = backup_root / 'older-incompatible-snapshot'
        invalid.mkdir()
        (invalid / 'snapshot-ready').touch()
        (invalid / 'states.json').write_text(json.dumps({
            manager.SERVICE: {'active': False, 'enabled': False},
            manager.CACHE: {'active': False, 'enabled': False},
        }))
        (invalid / 'config.json').write_text(json.dumps({'schema': 2}))
        (invalid / 'snapshot.json').write_text(json.dumps({
            'operation': 'upgrade', 'version': '9.9.9', 'snapshot_format': 1,
            'schema': 3, 'checksums': {},
        }))

        with patch.object(manager, 'validate', lambda _config: None):
            code, _ = self.invoke(['upgrade', '--yes', '--json'], ready=lambda _: None)

        self.assertEqual(code, 0)
        created = [item for item in manager.valid_backups()
                   if item['operation'] == 'upgrade' and item['id'] != invalid.name]
        self.assertEqual(len(created), 1)
        new_snapshot, _ = manager.validated_backup(created[0]['id'])
        self.assertNotEqual(new_snapshot, invalid)
        self.assertEqual(json.loads((new_snapshot / 'snapshot.json').read_text())['schema'], 3)

    def test_restore_dry_run_is_pure_and_restore_uses_fake_controller(self):
        self.invoke(self.setup_args() + ['--yes'])
        with patch.object(manager, 'read_config', return_value=json.loads(self.config_path.read_text())):
            self.invoke(['backup'])
        identifier = next(item['id'] for item in manager.valid_backups() if item['operation'] == 'backup')
        snapshot = Path(manager.CONFIG_PATH.parent / 'backups' / identifier)
        metadata = json.loads((snapshot / 'snapshot.json').read_text())
        self.assertEqual(metadata['version'], manager.VERSION)
        self.assertEqual(metadata['snapshot_format'], 1)
        self.assertEqual(metadata['checksums'], manager._snapshot_checksums(snapshot))
        self.ctl.calls.clear()
        code, _ = self.invoke(['restore', '--backup-id', identifier, '--dry-run', '--json'])
        self.assertEqual(code, 0); self.assertEqual(self.ctl.calls, [])
        with patch.object(manager, 'read_config', return_value=json.loads(self.config_path.read_text())):
            code, _ = self.invoke(['restore', '--backup-id', identifier, '--yes'])
        self.assertEqual(code, 0); self.assertIn(('stop', manager.CACHE, manager.SERVICE), self.ctl.calls)

    def test_restore_failure_recovers_current_files_and_preserves_errors(self):
        self.invoke(self.setup_args() + ['--yes'])
        original = self.config_path.read_bytes()
        with patch.object(manager, 'read_config', return_value=json.loads(original)):
            self.invoke(['backup'])
        identifier = next(item['id'] for item in manager.valid_backups() if item['operation'] == 'backup')
        self.config_path.write_bytes(original + b'\n')
        current = json.loads(self.config_path.read_text())
        with self.assertRaises(manager.TransactionFailure) as raised:
            manager.transactional_restore(identifier, current, ctl=self.ctl,
                                          ready=lambda _: (_ for _ in ()).throw(RuntimeError('readiness failure')),
                                          source_dir=Path(manager.__file__).resolve().parent, clock=datetime.now)
        self.assertIn('readiness failure', str(raised.exception.original))
        self.assertEqual(self.config_path.read_bytes(), original + b'\n')
        self.assertGreaterEqual(sum(call[0] == 'stop' for call in self.ctl.calls), 2)

    def test_upgrade_failure_restores_schema_2_bytes(self):
        config = manager.build_config(qwen_root=self.qwen, model=self.assets[0], codec=self.assets[1], voice_name='fixture', voice_spk=self.assets[2], voice_rvq=self.assets[3], voice_text=self.assets[4], cache_dir=self.root / 'cache')
        config['schema'] = 2
        self.config_path.parent.mkdir(parents=True); self.config_path.write_text(json.dumps(config, indent=3))
        original = self.config_path.read_bytes()
        with patch.object(manager, 'read_config', return_value=config), patch.object(manager, 'validate', lambda value: value):
            with self.assertRaises(manager.TransactionFailure):
                self.invoke(['upgrade', '--yes'], ready=lambda _: (_ for _ in ()).throw(RuntimeError('ready failed')))
        self.assertEqual(self.config_path.read_bytes(), original)

    def test_doctor_codes_cover_service_backend_voice_cache_and_protocol(self):
        config = manager.build_config(qwen_root=self.qwen, model=self.assets[0], codec=self.assets[1], voice_name='fixture', voice_spk=self.assets[2], voice_rvq=self.assets[3], voice_text=self.assets[4], cache_dir=self.root / 'cache')
        class Response(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *args): return False
        down = lambda *args, **kwargs: (_ for _ in ()).throw(OSError('down'))
        ownership = dict(qwen_pids=[424242], listener_probe=lambda *_: 'owned')
        report = manager.doctor_report(config, ctl=self.ctl, opener=down, **ownership)
        self.assertEqual(report['code'], 3)
        self.assertNotIn('down', json.dumps(report))
        missing_voice = manager.doctor_report(config, ctl=self.ctl, opener=lambda *a, **k: Response(b'{"voices": []}'), **ownership)
        self.assertEqual(missing_voice['code'], 4)
        self.assertNotIn('fixture', json.dumps(missing_voice))
        self.assertNotIn('voice', missing_voice)
        cache_down = iter([Response(b'{"voices": ["fixture"]}'), OSError('cache down')])
        def cache_failure(*args, **kwargs):
            item = next(cache_down)
            if isinstance(item, Exception): raise item
            return item
        cache_report = manager.doctor_report(config, ctl=self.ctl, opener=cache_failure, **ownership)
        self.assertEqual(cache_report['code'], 5)
        self.assertNotIn('cache down', json.dumps(cache_report))
        replies = iter([Response(b'{"voices": ["fixture"]}'), Response(b'{"version": "wrong", "mode": "qwen"}'), Response(b'{"mode": "qwen"}')])
        self.assertEqual(manager.doctor_report(config, ctl=self.ctl, opener=lambda *a, **k: next(replies), **ownership)['code'], 6)

    def test_doctor_text_and_json_share_validated_nondefault_upstream_port(self):
        config = manager.build_config(qwen_root=self.qwen, model=self.assets[0], codec=self.assets[1],
            voice_name='fixture-private-name', voice_spk=self.assets[2], voice_rvq=self.assets[3],
            voice_text=self.assets[4], cache_dir=self.root / 'private-cache')
        argv = config['profiles']['qwen']['argv']
        argv[argv.index('--port') + 1] = '18080'
        class Response(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *args): return False
        requested = []
        def healthy_opener(request, **kwargs):
            url = request.full_url if hasattr(request, 'full_url') else str(request)
            requested.append(url)
            if url.endswith('/v1/audio/voices'):
                return Response(b'{"voices":["fixture-private-name"]}')
            if url.endswith('/health'):
                return Response(json.dumps({'version': manager.VERSION, 'mode': 'qwen'}).encode())
            return Response(b'{"mode":"qwen"}')
        original_report = manager.doctor_report
        def report_with_local_fake(actual_config, *, ctl):
            return original_report(actual_config, ctl=ctl, opener=healthy_opener,
                                   qwen_pids=[424242], listener_probe=lambda *_: 'owned')
        with patch.object(manager, 'read_config', return_value=config), \
                patch.object(manager, 'doctor_report', side_effect=report_with_local_fake):
            text_code, text_output = self.invoke(['doctor'])
        with patch.object(manager, 'read_config', return_value=config), \
                patch.object(manager, 'doctor_report', side_effect=report_with_local_fake):
            json_code, json_output = self.invoke(['doctor', '--json'])
        self.assertEqual((text_code, json_code), (0, 0))
        self.assertIn('Porta upstream configurada: 18080', text_output)
        self.assertNotRegex(text_output, r'Porta upstream configurada: 8080(?:\D|$)')
        self.assertEqual(json.loads(json_output)['upstream_port'], 18080)
        self.assertEqual(sum(':18080/' in str(url) for url in requested), 2)
        for output in (text_output, json_output):
            self.assertNotIn(config['token'], output)
            self.assertNotIn('Authorization', output)
            self.assertNotIn('fixture-private-name', output)
            self.assertNotIn(str(self.root), output)

    def test_doctor_codes_zero_one_two_and_json_are_direct_and_redacted(self):
        config = manager.build_config(qwen_root=self.qwen, model=self.assets[0], codec=self.assets[1], voice_name='fixture', voice_spk=self.assets[2], voice_rvq=self.assets[3], voice_text=self.assets[4], cache_dir=self.root / 'cache')
        class Response(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *args): return False
        healthy = iter([Response(b'{"voices":["fixture"]}'), Response(json.dumps({'version': manager.VERSION, 'mode': 'qwen'}).encode()), Response(b'{"mode":"qwen"}')])
        owner = {'qwen_pids': [424242], 'listener_probe': lambda *_: 'owned'}
        self.assertEqual(manager.doctor_report(config, ctl=self.ctl, opener=lambda *a, **k: next(healthy), **owner)['code'], 0)
        with patch.object(manager, 'validate', side_effect=ValueError('invalid')):
            self.assertEqual(manager.doctor_report(config, ctl=self.ctl, **owner)['code'], 1)
        inactive = lambda *a, **k: SimpleNamespace(stdout='inactive\n')
        self.assertEqual(manager.doctor_report(config, ctl=inactive, **owner)['code'], 2)
        for code in range(7):
            with patch.object(manager, 'read_config', return_value=config), patch.object(manager, 'doctor_report', return_value={'code': code, 'healthy': code == 0}):
                result, output = self.invoke(['doctor', '--json'])
            self.assertEqual(result, code); self.assertEqual(json.loads(output)['code'], code)
            self.assertNotIn(config['token'], output); self.assertNotIn('Authorization', output)

    def test_noninteractive_upgrade_restore_and_json_require_yes_without_writes(self):
        config = manager.build_config(qwen_root=self.qwen, model=self.assets[0], codec=self.assets[1], voice_name='fixture', voice_spk=self.assets[2], voice_rvq=self.assets[3], voice_text=self.assets[4], cache_dir=self.root / 'cache')
        config['schema'] = 2; self.config_path.parent.mkdir(parents=True); self.config_path.write_text(json.dumps(config))
        original = self.config_path.read_bytes()
        with patch.object(manager, 'read_config', return_value=config):
            with self.assertRaisesRegex(ValueError, '--yes'): self.invoke(['upgrade', '--json'])
        self.assertEqual(self.config_path.read_bytes(), original); self.assertEqual(self.ctl.calls, [])
        self.invoke(self.setup_args() + ['--yes'])
        with patch.object(manager, 'read_config', return_value=json.loads(self.config_path.read_text())): self.invoke(['backup'])
        identifier = next(item['id'] for item in manager.valid_backups() if item['operation'] == 'backup')
        self.ctl.calls.clear()
        with self.assertRaisesRegex(ValueError, '--yes'): self.invoke(['restore', '--backup-id', identifier, '--json'])
        self.assertEqual(self.ctl.calls, [])

    def test_interactive_cancellation_leaves_setup_upgrade_restore_intact(self):
        no = lambda _: 'não'
        with self.assertRaisesRegex(ValueError, 'cancelada'):
            self.invoke(self.setup_args(), interactive=True, input_fn=no)
        self.assertFalse(self.config_path.exists()); self.assertEqual(self.ctl.calls, [])
        config = manager.build_config(qwen_root=self.qwen, model=self.assets[0], codec=self.assets[1], voice_name='fixture', voice_spk=self.assets[2], voice_rvq=self.assets[3], voice_text=self.assets[4], cache_dir=self.root / 'cache')
        config['schema'] = 2; self.config_path.parent.mkdir(parents=True); self.config_path.write_text(json.dumps(config, indent=3)); original = self.config_path.read_bytes()
        with patch.object(manager, 'read_config', return_value=config):
            with self.assertRaisesRegex(ValueError, 'cancelada'): self.invoke(['upgrade'], interactive=True, input_fn=no)
        self.assertEqual(self.config_path.read_bytes(), original); self.assertEqual(self.ctl.calls, [])
        self.invoke(self.setup_args() + ['--yes'])
        with patch.object(manager, 'read_config', return_value=json.loads(self.config_path.read_text())): self.invoke(['backup'])
        identifier = next(item['id'] for item in manager.valid_backups() if item['operation'] == 'backup')
        before = self.config_path.read_bytes(); backups = list(manager.valid_backups()); self.ctl.calls.clear()
        with self.assertRaisesRegex(ValueError, 'cancelada'):
            self.invoke(['restore', '--backup-id', identifier], interactive=True, input_fn=no)
        self.assertEqual(self.config_path.read_bytes(), before); self.assertEqual(len(manager.valid_backups()), len(backups)); self.assertEqual(self.ctl.calls, [])


if __name__ == '__main__': unittest.main()
