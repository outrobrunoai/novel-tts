import json
import io
import shutil
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import novel_tts as manager
from nlr_config import option

REAL_BUILD_CONFIG = manager.build_config


class FakeSystemctl:
    """Explicit in-memory controller; it never starts a real process."""
    def __init__(self, fail_action=None):
        self.calls = []
        self.fail_action = fail_action
        self.failed = False
        self.active = {manager.SERVICE: True, manager.CACHE: True}
        self.enabled = {manager.SERVICE: True, manager.CACHE: True}

    def __call__(self, *args, check=True):
        self.calls.append(args)
        action, *units = args
        if action in ('start', 'stop'):
            for name in units:
                if name in self.active:
                    self.active[name] = action == 'start'
        elif action in ('enable', 'disable'):
            for name in units:
                if name in self.enabled:
                    self.enabled[name] = action == 'enable'
        if args[0] == self.fail_action and not self.failed:
            self.failed = True
            raise RuntimeError(f'fake {args[0]} failure')
        if action == 'is-active':
            output = ('active' if self.active[units[0]] else 'inactive') + '\n'
        elif action == 'is-enabled':
            output = ('enabled' if self.enabled[units[0]] else 'disabled') + '\n'
        else:
            output = ''
        return SimpleNamespace(stdout=output, returncode=0)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = self.root / 'user'
        self.units = self.home / '.config/systemd/user'
        self.app = self.home / '.local/share/novel-local-reader'
        self.config_path = self.home / '.config/novel-local-reader/config.json'
        self.units.mkdir(parents=True)
        self.app.mkdir(parents=True)
        (self.app / 'old.txt').write_text('legacy app')
        self.qwen = self.root / 'qwen'
        self.qwen.mkdir()
        self.server = self.qwen / 'build/tts-server'
        self.server.parent.mkdir()
        self.server.write_text('test server')
        self.server.chmod(0o755)
        self.model, self.codec = self.root / 'talker.gguf', self.root / 'codec.gguf'
        self.spk, self.rvq, self.transcript = self.root / 'voice.spk', self.root / 'voice.rvq', self.root / 'voice.txt'
        for path in (self.model, self.codec, self.spk, self.rvq, self.transcript): path.write_text('test')
        for name in (manager.SERVICE, manager.CACHE): (self.units / name).write_text('[Service]\nExecStart=/bin/old\n')
        override = self.units / (manager.SERVICE + '.d')
        override.mkdir(); (override / 'override.conf').write_text('original override')
        self.config = {
            'schema': 2, 'backend': 'qwen3', 'mode': 'qwen', 'data_root': str(self.root),
            'cache_dir': str(self.root / 'cache'), 'cache_limit_mb': 4096, 'voice': 'test', 'token': 'test',
            'profiles': {'qwen': {'cwd': str(self.root), 'argv': ['/bin/true'], 'voices': {'test': {}}}},
        }
        self.ctl, self.ready = FakeSystemctl(), Mock()
        self.clock = lambda: datetime(2026, 1, 2, 3, 4, 5, 6789)
        self.tripwire_calls = []

        def tripwire(*args, **kwargs):
            self.tripwire_calls.append((args, kwargs))
            raise AssertionError(f'blocked unmocked subprocess execution: {args!r}')

        def capture_fixture_app(_app, _operation):
            return {'fixture': True}

        def copy_fixture_app(_app, staging, _capture):
            shutil.copytree(self.app, Path(staging) / 'app')
            return True, None, 0

        # Fail closed for every command-shaped subprocess API. Tests may only
        # cross that boundary through FakeSystemctl or an explicit local fake.
        self.patches = [
            patch.object(manager, 'APP', self.app), patch.object(manager, 'UNITS', self.units),
            patch.object(manager, 'CONFIG_PATH', self.config_path), patch.object(Path, 'home', return_value=self.home),
            patch.object(manager, 'validate', lambda config, *args: config),
            # The generic installer fixture deliberately contains old.txt, not
            # a recognized legacy package; dedicated CLI tests cover that gate.
            patch.object(manager, '_recognized_legacy_ownership', return_value=None),
            patch.object(manager, '_validate_ownership', return_value=None),
            # This suite exercises transaction mechanics with a deliberately
            # synthetic app tree; ownership policy has dedicated CLI tests.
            patch.object(manager, '_read_owned_application', side_effect=capture_fixture_app),
            patch.object(manager, '_copy_owned_application_snapshot', side_effect=copy_fixture_app),
            patch.object(manager, '_verify_snapshot_application_source',
                         side_effect=lambda _app, _staging, _capture, ignored: ignored),
            patch.object(manager.subprocess, 'run', side_effect=tripwire),
            patch.object(manager.subprocess, 'Popen', side_effect=tripwire),
            patch.object(manager.subprocess, 'call', side_effect=tripwire),
            patch.object(manager.subprocess, 'check_call', side_effect=tripwire),
            patch.object(manager.subprocess, 'check_output', side_effect=tripwire),
        ]
        for item in self.patches: item.start()

    def tearDown(self):
        for item in reversed(self.patches): item.stop()
        self.tmp.cleanup()

    def transaction(self, ctl=None, ready=None):
        return manager.InstallTransaction(
            self.config, ctl=self.ctl if ctl is None else ctl, ready=self.ready if ready is None else ready,
            source_dir=Path(manager.__file__).resolve().parent, clock=self.clock,
        )

    def install(self, ctl=None, ready=None):
        with patch.object(manager, 'build_config', return_value=self.config):
            return manager.install(
                self.root, ctl=self.ctl if ctl is None else ctl, ready=self.ready if ready is None else ready,
                source_dir=Path(manager.__file__).resolve().parent, clock=self.clock,
            )

    def test_transaction_requires_explicit_side_effect_dependencies(self):
        with self.assertRaises(TypeError): manager.InstallTransaction(self.config)

    def test_fake_controller_is_used_and_unmocked_systemctl_is_blocked(self):
        self.transaction().run()
        self.assertIn(('stop', manager.CACHE, manager.SERVICE), self.ctl.calls)
        self.assertEqual(self.tripwire_calls, [])
        with self.assertRaisesRegex(AssertionError, 'blocked unmocked subprocess'):
            manager.systemctl('status', manager.SERVICE)
        self.assertEqual(self.tripwire_calls[0][0][0][:2], ['systemctl', '--user'])

    def test_custom_dropin_blocks_before_stopping_service(self):
        (self.units / (manager.SERVICE + '.d') / 'custom.conf').write_text('custom')
        with self.assertRaises(ValueError): self.install()
        self.assertFalse(any(call[0] == 'stop' for call in self.ctl.calls))

    def test_failed_validation_preserves_current_installation(self):
        with patch.object(manager, 'validate', side_effect=ValueError('HD missing')):
            with self.assertRaises(ValueError): self.install()
        self.assertFalse(any(call[0] == 'stop' for call in self.ctl.calls))
        self.assertEqual((self.app / 'old.txt').read_text(), 'legacy app')

    def test_snapshot_marker_is_written_only_after_complete_snapshot(self):
        self.config_path.parent.mkdir(parents=True); self.config_path.write_text('{"old": true}')
        launcher = self.home / '.local/bin/novel-tts'
        launcher.parent.mkdir(parents=True); launcher.write_text('old launcher')
        transaction = self.transaction(); transaction.plan(); transaction.snapshot()
        self.assertTrue((transaction.backup / 'snapshot-ready').exists())
        self.assertTrue((transaction.backup / 'states.json').exists())
        self.assertEqual((transaction.backup / 'app/old.txt').read_text(), 'legacy app')
        self.assertEqual((transaction.backup / 'config.json').read_text(), '{"old": true}')
        self.assertEqual((transaction.backup / 'novel-tts').read_text(), 'old launcher')

    def upgrade_config(self):
        config = json.loads(json.dumps(self.config))
        config['schema'] = 3
        config['require_mount'] = True
        return config

    def test_upgrade_preserves_disabled_inactive_units_without_enable_or_start(self):
        class GuardedController(FakeSystemctl):
            def __init__(self):
                super().__init__()
                self.active = {manager.SERVICE: False, manager.CACHE: False}
                self.enabled = {manager.SERVICE: False, manager.CACHE: False}
                self.captured_active = dict(self.active)
                self.captured_enabled = dict(self.enabled)

            def __call__(self, *args, **kwargs):
                action, *units = args
                for name in units:
                    if action == 'enable' and not self.captured_enabled[name]:
                        raise AssertionError('upgrade tentou habilitar unit capturada como disabled')
                    if action == 'start' and not self.captured_active[name]:
                        raise AssertionError('upgrade tentou iniciar unit capturada como inactive')
                return super().__call__(*args, **kwargs)

        ctl = GuardedController()
        ready = Mock()
        transaction = manager.InstallTransaction(
            self.upgrade_config(), ctl=ctl, ready=ready,
            source_dir=Path(manager.__file__).resolve().parent, clock=self.clock,
        )
        transaction.run(operation='upgrade')

        self.assertEqual(transaction.states, {
            manager.SERVICE: {'active': False, 'enabled': False},
            manager.CACHE: {'active': False, 'enabled': False},
        })
        self.assertEqual(transaction.target_states, transaction.states)
        self.assertFalse(any(call[0] in ('enable', 'start') for call in ctl.calls))
        self.assertEqual(ctl.active, {manager.SERVICE: False, manager.CACHE: False})
        self.assertEqual(ctl.enabled, {manager.SERVICE: False, manager.CACHE: False})
        self.assertNotEqual(transaction.state, manager.TransactionState.READY)
        ready.assert_not_called()

    def test_upgrade_preserves_different_enabled_and_active_state_per_unit(self):
        ctl = FakeSystemctl()
        ctl.active = {manager.SERVICE: False, manager.CACHE: True}
        ctl.enabled = {manager.SERVICE: True, manager.CACHE: False}
        initial_active = dict(ctl.active)
        initial_enabled = dict(ctl.enabled)
        ready = Mock()
        transaction = manager.InstallTransaction(
            self.upgrade_config(), ctl=ctl, ready=ready,
            source_dir=Path(manager.__file__).resolve().parent, clock=self.clock,
        )

        transaction.run(operation='upgrade')

        self.assertEqual(transaction.target_states, {
            manager.SERVICE: {'active': False, 'enabled': True},
            manager.CACHE: {'active': True, 'enabled': False},
        })
        self.assertEqual(ctl.active, initial_active)
        self.assertEqual(ctl.enabled, initial_enabled)
        self.assertIn(('enable', manager.SERVICE), ctl.calls)
        self.assertIn(('disable', manager.CACHE), ctl.calls)
        self.assertIn(('start', manager.CACHE), ctl.calls)
        self.assertIn(('stop', manager.SERVICE), ctl.calls)
        ready.assert_not_called()

    def test_upgrade_rollback_restores_individual_captured_unit_states(self):
        class FailDuringStateVerification(FakeSystemctl):
            def __init__(self):
                super().__init__()
                self.active = {manager.SERVICE: False, manager.CACHE: True}
                self.enabled = {manager.SERVICE: False, manager.CACHE: True}
                self.active_reads = 0

            def __call__(self, *args, **kwargs):
                if args[0] == 'is-active':
                    self.active_reads += 1
                    if self.active_reads == 3:
                        self.calls.append(args)
                        raise RuntimeError('injected state verification failure')
                return super().__call__(*args, **kwargs)

        ctl = FailDuringStateVerification()
        initial_active = dict(ctl.active)
        initial_enabled = dict(ctl.enabled)
        ready = Mock()
        transaction = manager.InstallTransaction(
            self.upgrade_config(), ctl=ctl, ready=ready,
            source_dir=Path(manager.__file__).resolve().parent, clock=self.clock,
        )

        with self.assertRaises(manager.TransactionFailure) as raised:
            transaction.run(operation='upgrade')

        self.assertEqual(raised.exception.stage, 'unit_state_verification')
        self.assertEqual(raised.exception.rollback_status, 'complete')
        self.assertEqual(transaction.state, manager.TransactionState.ROLLED_BACK)
        self.assertEqual(ctl.active, initial_active)
        self.assertEqual(ctl.enabled, initial_enabled)
        self.assertEqual(transaction.states, transaction.target_states)
        ready.assert_not_called()

    def test_upgrade_aborts_before_snapshot_or_stop_when_state_capture_is_incomplete(self):
        class IncompleteController(FakeSystemctl):
            def __call__(self, *args, **kwargs):
                if args == ('is-enabled', manager.CACHE):
                    self.calls.append(args)
                    return SimpleNamespace(stdout='not-found\n', returncode=1)
                return super().__call__(*args, **kwargs)

        ctl = IncompleteController()
        transaction = manager.InstallTransaction(
            self.upgrade_config(), ctl=ctl, ready=Mock(),
            source_dir=Path(manager.__file__).resolve().parent, clock=self.clock,
        )

        with self.assertRaisesRegex(ValueError, 'captura dos estados'):
            transaction.run(operation='upgrade')

        self.assertFalse(any(call[0] == 'stop' for call in ctl.calls))
        self.assertFalse(any(call[0] in ('enable', 'disable', 'start') for call in ctl.calls))
        self.assertFalse((self.config_path.parent / 'backups' / '20260102-030405-006789').exists())

    def test_upgrade_swap_refuses_missing_target_states_before_any_mutation(self):
        transaction = manager.InstallTransaction(
            self.upgrade_config(), ctl=self.ctl, ready=Mock(),
            source_dir=Path(manager.__file__).resolve().parent, clock=self.clock,
        )
        transaction.operation = 'upgrade'

        with self.assertRaisesRegex(ValueError, 'não foram capturados'):
            transaction.swap()

        self.assertFalse(self.ctl.calls)
        self.assertEqual((self.app / 'old.txt').read_text(), 'legacy app')
        self.assertFalse(self.config_path.exists())

    def test_setup_keeps_default_enabled_active_behavior(self):
        ctl = FakeSystemctl()
        ctl.active = {manager.SERVICE: False, manager.CACHE: False}
        ctl.enabled = {manager.SERVICE: False, manager.CACHE: False}
        transaction = manager.InstallTransaction(
            self.upgrade_config(), ctl=ctl, ready=Mock(),
            source_dir=Path(manager.__file__).resolve().parent, clock=self.clock,
        )

        transaction.run(operation='setup')

        self.assertTrue(all(ctl.active.values()))
        self.assertTrue(all(ctl.enabled.values()))

    def test_snapshot_failure_has_no_eligibility_marker_or_stop(self):
        with patch.object(manager, 'atomic_json', side_effect=OSError('snapshot write failure')):
            with self.assertRaisesRegex(OSError, 'snapshot write failure'): self.transaction().run()
        backup = self.config_path.parent / 'backups' / '20260102-030405-006789'
        self.assertFalse((backup / 'snapshot-ready').exists())
        self.assertFalse(any(call[0] == 'stop' for call in self.ctl.calls))

    def test_snapshot_rejects_nested_symlink_before_copy_or_eligibility(self):
        outside = self.root / 'private-outside'
        outside.write_text('must not be copied')
        (self.app / 'external-link').symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'link ou arquivo especial'):
            self.transaction().run()
        backup = self.config_path.parent / 'backups' / '20260102-030405-006789'
        self.assertFalse((backup / 'snapshot-ready').exists())
        self.assertFalse(any(call[0] == 'stop' for call in self.ctl.calls))
        self.assertFalse(any(path.read_text() == outside.read_text()
                             for path in (backup / 'app').glob('**/*') if path.is_file()))

    def test_staged_configuration_write_failure_leaves_installation_and_service_state_untouched(self):
        self.config_path.parent.mkdir(parents=True)
        original = b'{"schema":3,"marker":"before"}\n'
        self.config_path.write_bytes(original)
        real_atomic_json = manager.atomic_json

        def fail_staged_config(path, data):
            path = Path(path)
            if path.name == 'config.json' and path.parent.name.startswith('.nlr-stage-'):
                raise OSError('injected staged config write failure')
            return real_atomic_json(path, data)

        with patch.object(manager, 'atomic_json', side_effect=fail_staged_config):
            with self.assertRaisesRegex(OSError, 'staged config write failure'):
                self.transaction().run()
        self.assertEqual(self.config_path.read_bytes(), original)
        self.assertEqual(self.ctl.active, {manager.SERVICE: True, manager.CACHE: True})
        self.assertEqual(self.ctl.enabled, {manager.SERVICE: True, manager.CACHE: True})
        self.assertFalse(any(call[0] == 'stop' for call in self.ctl.calls))

    def test_staging_is_private(self):
        transaction = self.transaction(); transaction.plan(); transaction.snapshot(); transaction.stage_files()
        self.assertEqual(transaction.stage.stat().st_mode & 0o077, 0)

    def test_failure_before_stop_never_attempts_rollback(self):
        with patch.object(manager.tempfile, 'mkdtemp', side_effect=OSError('no staging')):
            with self.assertRaisesRegex(OSError, 'no staging'): self.transaction().run()
        self.assertFalse(any(call[0] == 'stop' for call in self.ctl.calls))

    def assert_rollback_after(self, action, ready=None):
        ctl = FakeSystemctl(fail_action=action)
        transaction = self.transaction(ctl=ctl, ready=ready)
        with self.assertRaises(manager.TransactionFailure) as raised: transaction.run()
        self.assertIsInstance(raised.exception.original, Exception)
        self.assertEqual(transaction.state, manager.TransactionState.ROLLED_BACK)
        self.assertGreaterEqual(sum(call[0] == 'stop' for call in ctl.calls), 2)
        self.assertIn(('daemon-reload',), ctl.calls)
        self.assertEqual((self.app / 'old.txt').read_text(), 'legacy app')
        return raised.exception, ctl

    def test_stop_failure_rolls_back_because_stop_may_be_partial(self): self.assert_rollback_after('stop')

    def test_swap_failure_rolls_back(self):
        real_replace = manager.os.replace
        def fail_config_swap(source, destination):
            if Path(destination) == self.config_path: raise OSError('swap failure')
            return real_replace(source, destination)
        with patch.object(manager.os, 'replace', side_effect=fail_config_swap):
            self.assert_rollback_after('never')

    def test_application_copy_failure_restores_previous_bytes_and_service_states(self):
        self.config_path.parent.mkdir(parents=True)
        self.config_path.write_bytes(b'{"previous":true}\n')
        app_bytes = {path.name: path.read_bytes() for path in self.app.iterdir() if path.is_file()}
        self.ctl.active[manager.SERVICE] = False
        self.ctl.enabled[manager.CACHE] = False
        real_copytree = manager.shutil.copytree
        failed = {'value': False}

        def fail_install_app_copy(source, destination, *args, **kwargs):
            if Path(destination) == self.app and not failed['value']:
                failed['value'] = True
                raise OSError('injected application copy failure')
            return real_copytree(source, destination, *args, **kwargs)

        with patch.object(manager.shutil, 'copytree', side_effect=fail_install_app_copy):
            with self.assertRaises(manager.TransactionFailure) as raised:
                self.transaction().run()
        self.assertIn('injected application copy failure', str(raised.exception.original))
        self.assertEqual({path.name: path.read_bytes() for path in self.app.iterdir() if path.is_file()}, app_bytes)
        self.assertEqual(self.config_path.read_bytes(), b'{"previous":true}\n')
        self.assertEqual(self.ctl.active, {manager.SERVICE: False, manager.CACHE: True})
        self.assertEqual(self.ctl.enabled, {manager.SERVICE: True, manager.CACHE: False})

    def test_snapshot_checksum_is_complete_and_snapshot_never_eligible_on_checksum_failure(self):
        real_checksum = manager._snapshot_checksums
        with patch.object(manager, '_snapshot_checksums', side_effect=OSError('checksum write failure')):
            with self.assertRaisesRegex(OSError, 'checksum write failure'):
                self.transaction().run()
        backup = self.config_path.parent / 'backups' / '20260102-030405-006789'
        self.assertFalse((backup / 'snapshot-ready').exists())
        self.assertFalse(any(call[0] == 'stop' for call in self.ctl.calls))
        self.assertTrue(callable(real_checksum))

    def test_daemon_reload_failure_rolls_back(self): self.assert_rollback_after('daemon-reload')
    def test_enable_failure_rolls_back(self): self.assert_rollback_after('enable')
    def test_disable_failure_after_partial_unit_change_rolls_back(self):
        ctl = FakeSystemctl(fail_action='disable')
        transaction = self.transaction(ctl=ctl)
        transaction.plan()
        transaction.snapshot()
        transaction.stage_files()
        transaction.target_states = {
            manager.SERVICE: {'active': False, 'enabled': False},
            manager.CACHE: {'active': True, 'enabled': True},
        }
        with self.assertRaisesRegex(RuntimeError, 'fake disable failure'):
            transaction.swap()
        transaction.restore()
        self.assertEqual(ctl.active, {manager.SERVICE: True, manager.CACHE: True})
        self.assertEqual(ctl.enabled, {manager.SERVICE: True, manager.CACHE: True})
    def test_start_failure_rolls_back_with_specific_safe_stage_and_code(self):
        failure, _ = self.assert_rollback_after('start')
        self.assertEqual(failure.stage, 'unit_start')
        self.assertEqual(failure.code, 'NLR_UPGRADE_UNIT_STATE_FAILED')
        self.assertEqual(failure.rollback_status, 'complete')

    def test_readiness_failure_rolls_back(self):
        failure, _ = self.assert_rollback_after('never', ready=Mock(side_effect=RuntimeError('not ready')))
        self.assertEqual(failure.stage, 'readiness')
        self.assertEqual(failure.code, 'NLR_READINESS_FAILED')

    def test_rollback_order_stops_new_units_before_reloading_and_restoring_states(self):
        _, ctl = self.assert_rollback_after('daemon-reload')
        stop_positions = [i for i, call in enumerate(ctl.calls) if call[0] == 'stop']
        reload_positions = [i for i, call in enumerate(ctl.calls) if call[0] == 'daemon-reload']
        restore_reload = reload_positions[-1]
        self.assertLess(stop_positions[-1], restore_reload)
        self.assertTrue(all(call[0] in ('enable', 'disable', 'start', 'stop', 'is-active', 'is-enabled')
                            for call in ctl.calls[restore_reload + 1:]))

    def test_original_and_rollback_errors_are_preserved(self):
        ctl = FakeSystemctl(fail_action='enable')
        original, stops = ctl.__call__, {'count': 0}
        def failing(*args, **kwargs):
            if args[0] == 'stop':
                stops['count'] += 1
                if stops['count'] == 2: raise RuntimeError('rollback stop failure')
            return original(*args, **kwargs)
        with self.assertRaises(manager.TransactionFailure) as raised: self.transaction(ctl=failing).run()
        self.assertIn('fake enable failure', str(raised.exception.original))
        self.assertIn('rollback stop failure', str(raised.exception.rollback_error))
        self.assertEqual(raised.exception.stage, 'unit_enablement')
        self.assertEqual(raised.exception.code, 'NLR_ROLLBACK_PARTIAL')
        self.assertEqual(raised.exception.rollback_status, 'partial')
        self.assertNotIn('rollback stop failure', str(raised.exception))

    def test_readiness_failure_exposes_only_stage_and_safe_code(self):
        private_details = 'token-marker /private/model.gguf voice-marker --private-arg'
        ready = Mock(side_effect=RuntimeError(private_details))
        with self.assertRaises(manager.TransactionFailure) as raised:
            self.transaction(ready=ready).run()
        failure = raised.exception
        self.assertEqual(failure.stage, 'readiness')
        self.assertEqual(failure.code, 'NLR_READINESS_FAILED')
        self.assertEqual(failure.rollback_status, 'complete')
        self.assertIn(private_details, str(failure.original))
        public = json.dumps(failure.public_detail())
        for marker in ('token-marker', '/private/model.gguf', 'voice-marker', '--private-arg'):
            self.assertNotIn(marker, public)

    def test_preflight_failure_has_stage_code_and_does_not_attempt_rollback(self):
        transaction = self.transaction()
        with patch.object(manager, 'validate', side_effect=ValueError('private path /fixture/config')):
            with self.assertRaises(Exception) as raised:
                manager._run_cli_transaction(transaction)
        self.assertIsInstance(raised.exception, manager.TransactionFailure)
        self.assertEqual(raised.exception.stage, 'validation')
        self.assertEqual(raised.exception.code, 'NLR_UPGRADE_VALIDATION_FAILED')
        self.assertEqual(raised.exception.rollback_status, 'not-needed')
        self.assertNotIn('/fixture/config', json.dumps(raised.exception.public_detail()))
        self.assertFalse(any(call[0] == 'stop' for call in self.ctl.calls))

    def test_unknown_listener_readiness_has_stable_process_code(self):
        config = dict(self.config)
        config['profiles'] = {
            'qwen': dict(
                self.config['profiles']['qwen'],
                argv=['server', '--host', '127.0.0.1', '--port', '18080'],
            )
        }
        with self.assertRaises(manager.ReadinessFailure) as raised:
            manager.wait_ready(
                config, timeout=0.1, qwen_pids=[424242], listener_probe=lambda *_: 'unknown'
            )
        self.assertEqual(raised.exception.diagnostic_code, 'NLR_QWEN_PROCESS_UNVERIFIED')
        self.assertNotIn('token', str(raised.exception).lower())

    def test_cli_json_failure_record_is_structured_and_redacted(self):
        original = RuntimeError('secret-token /home/private/voice.spk --model private.gguf')
        error = manager.TransactionFailure(original, stage='readiness', rollback_status='complete')
        record = manager.cli_failure_record(error)
        self.assertEqual(record, {
            'ok': False,
            'error': {
                'code': 'NLR_READINESS_FAILED',
                'stage': 'readiness',
                'rollback': 'complete',
                'message': 'A operação falhou; detalhes sensíveis foram omitidos.',
            },
        })
        output = json.dumps(record)
        for marker in ('secret-token', '/home/private', 'voice.spk', 'private.gguf'):
            self.assertNotIn(marker, output)
        cli_output = manager.cli_failure_output(error, json_output=True)
        self.assertEqual(json.loads(cli_output), record)
        self.assertEqual(cli_output.count('\n'), 0)
        plain_output = manager.cli_failure_output(error)
        self.assertIn('etapa readiness', plain_output)
        for marker in ('secret-token', '/home/private', 'voice.spk', 'private.gguf'):
            self.assertNotIn(marker, plain_output)

    def test_readiness_requires_voice_and_authenticated_cache_health_and_identity(self):
        class Response(io.BytesIO):
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): return False
        config = dict(self.config)
        config['profiles'] = {'qwen': dict(self.config['profiles']['qwen'], argv=['server', '--host', '127.0.0.1', '--port', '8080'])}
        responses = [Response(b'{"ok":true}'), Response(b'{"voices": ["test"]}'),
                     Response(b'{}'), Response(b'{}')]
        with patch.object(manager.urllib.request, 'urlopen', side_effect=responses) as urlopen:
            manager.wait_ready(config, timeout=1, qwen_pids=[424242], listener_probe=lambda *_: 'owned')
        self.assertEqual(urlopen.call_count, 4)
        self.assertTrue(urlopen.call_args_list[0].args[0].endswith('/health'))
        self.assertTrue(urlopen.call_args_list[1].args[0].endswith('/v1/audio/voices'))
        self.assertEqual(urlopen.call_args_list[2].args[0].get_header('Authorization'), 'Bearer test')
        self.assertTrue(urlopen.call_args_list[3].args[0].full_url.endswith('/identity'))

    def test_registered_voice_names_accepts_real_objects_and_legacy_strings(self):
        self.assertEqual(manager.registered_voice_names({'voices': ['test', 'other']}), {'test', 'other'})
        self.assertEqual(manager.registered_voice_names({'voices': [{'name': 'test'}, {'name': 'other'}]}),
                         {'test', 'other'})
        self.assertEqual(manager.registered_voice_names({'voices': []}), set())
        self.assertEqual(manager.registered_voice_names({'voices': [{'id': 'test'}, {'name': 3}, None]}), set())
        with self.assertRaises(ValueError): manager.registered_voice_names({'voices': 'test'})
        with self.assertRaises(ValueError): manager.registered_voice_names([])

    def test_readiness_accepts_voice_object_and_rejects_absent_or_malformed_voice(self):
        class Response(io.BytesIO):
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): return False
        config = dict(self.config)
        config['profiles'] = {'qwen': dict(self.config['profiles']['qwen'],
                                         argv=['server', '--host', '127.0.0.1', '--port', '8080'])}
        def check(voices, expected_failure=None):
            now = {'value': 0.0}

            def clock():
                return now['value']

            def sleep(delay):
                now['value'] += delay

            def opener(request, **_kwargs):
                url = request.full_url if hasattr(request, 'full_url') else str(request)
                if url.endswith('/v1/audio/voices'):
                    return Response(json.dumps({'voices': voices}).encode())
                if url.endswith('/identity'):
                    return Response(b'{"mode":"qwen"}')
                if url.startswith('http://127.0.0.1:8081/'):
                    return Response(json.dumps({'version': manager.VERSION, 'mode': 'qwen'}).encode())
                return Response(b'{"ok":true}')

            if expected_failure:
                with self.assertRaises(manager.ReadinessFailure) as raised:
                    manager.wait_ready(config, timeout=.25, qwen_pids=[424242],
                        listener_probe=lambda *_: 'owned', opener=opener, clock=clock, sleeper=sleep)
                self.assertEqual(raised.exception.diagnostic_code, expected_failure)
            else:
                manager.wait_ready(config, timeout=.25, qwen_pids=[424242],
                    listener_probe=lambda *_: 'owned', opener=opener, clock=clock, sleeper=sleep)
        check([{'name': 'test'}])
        check([{'name': 'other'}], 'NLR_VOICE_NOT_CONFIRMED')
        check([], 'NLR_VOICE_NOT_CONFIRMED')
        check([{'id': 'test'}], 'NLR_VOICE_NOT_CONFIRMED')

    def test_doctor_accepts_voice_object_without_exposing_voice_data(self):
        class Response(io.BytesIO):
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): return False
        config = dict(self.config)
        config['profiles'] = {'qwen': dict(self.config['profiles']['qwen'],
                                         argv=['server', '--host', '127.0.0.1', '--port', '8080'])}
        replies = iter([Response(b'{"voices":[{"name":"test"}]}'),
                        Response(json.dumps({'version': manager.VERSION, 'mode': 'qwen'}).encode()),
                        Response(b'{"mode":"qwen"}')])
        report = manager.doctor_report(config, ctl=self.ctl,
            opener=lambda *_args, **_kw: next(replies), qwen_pids=[424242],
            listener_probe=lambda *_: 'owned')
        self.assertEqual(report['code'], 0)
        self.assertNotIn('test', json.dumps(report))

    def portable_arguments(self, **overrides):
        arguments = dict(qwen_root=self.qwen, model=self.model, codec=self.codec, voice_name='test-voice',
                         voice_spk=self.spk, voice_rvq=self.rvq, voice_text=self.transcript)
        arguments.update(overrides); return arguments

    def test_build_config_uses_xdg_defaults_and_explicit_assets(self):
        with patch.object(manager, 'DEFAULT_CACHE_DIR', self.root / 'xdg-cache'): config = REAL_BUILD_CONFIG(**self.portable_arguments())
        profile = config['profiles']['qwen']
        self.assertEqual(config['backend'], 'qwen3'); self.assertEqual(config['schema'], 3); self.assertFalse(config['require_mount'])
        self.assertEqual(config['cache_dir'], str(self.root / 'xdg-cache')); self.assertEqual(config['data_root'], '')
        self.assertEqual(profile['argv'][0], str(self.server)); self.assertIn('test-voice', profile['voices'])
        self.assertEqual(set(profile['voices']), {'test-voice'})

    def test_build_config_preserves_existing_preferences_and_accepts_parameters(self):
        config = REAL_BUILD_CONFIG(self.root / 'mounted-data', previous={'token': 'same-token', 'cache_dir': str(self.root / 'old-cache'), 'cache_limit_mb': 777, 'require_mount': True}, language='Portuguese', qwen_port=18080, **self.portable_arguments())
        profile = config['profiles']['qwen']
        self.assertEqual(config['token'], 'same-token'); self.assertEqual(config['cache_limit_mb'], 777); self.assertTrue(config['require_mount'])
        self.assertEqual(option(profile['argv'], '--lang'), 'Portuguese'); self.assertEqual(option(profile['argv'], '--port'), '18080')

    def test_build_config_requires_user_supplied_assets(self):
        with self.assertRaisesRegex(ValueError, '--qwen-root'): REAL_BUILD_CONFIG()

    def test_launch_starts_server_then_registers_voice(self):
        child = Mock(); child.poll.return_value = 0; child.wait.return_value = 0
        profile = self.config['profiles']['qwen']
        with patch.object(manager, 'validate', lambda config: config), patch.object(manager, 'active_profile', return_value=profile), patch.object(manager, 'ensure_qwen_port_available') as available, patch.object(manager.subprocess, 'Popen', return_value=child) as popen, patch.object(manager, 'register_when_ready') as register:
            manager.launch(self.config)
        available.assert_called_once_with(profile)
        popen.assert_called_once_with(profile['argv'], cwd=profile['cwd'], env=unittest.mock.ANY)
        # The service must not give up on a slow cold start before the CLI's own
        # --ready-timeout ceiling (1800 s), or every restart would begin it again.
        self.assertGreaterEqual(manager.LAUNCH_READY_TIMEOUT, 1800)
        register.assert_called_once_with(child, profile, timeout=manager.LAUNCH_READY_TIMEOUT)


if __name__ == '__main__': unittest.main()
