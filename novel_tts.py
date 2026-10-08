#!/usr/bin/env python3
"""Install and supervise Novel TTS with a local Qwen3-TTS server."""
import argparse
import base64
import functools
import hashlib
import importlib.util
import json
import marshal
import os
import re
import secrets
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import types
import urllib.error
import urllib.request
from datetime import datetime
from enum import Enum
from pathlib import Path

MIN_PYTHON = (3, 10)
if sys.version_info < MIN_PYTHON:
    raise SystemExit('Este host requer Python 3.10 ou superior em /usr/bin/python3.')

from nlr_config import (APP_NAME, CONFIG_PATH, DEFAULT_CACHE_DIR, XDG_DATA_HOME,
                        active_profile, atomic_bytes, atomic_json, configuration_schema,
                        migrate_schema_2_to_3, option, read_config, validate)

SERVICE = 'novel-local-reader.service'
CACHE = 'novel-local-reader-cache.service'
APP = XDG_DATA_HOME / APP_NAME
UNITS = CONFIG_PATH.parent.parent / 'systemd/user'
VERSION = '1.0.0'
SNAPSHOT_FORMAT = 1
LEGACY_SNAPSHOT_VERSION = '1.4.0'
# Last internal "Novel Local Reader" build; its installs and snapshots upgrade to 1.0.0.
INTERNAL_RELEASE = '1.5.0'
PREVIOUS_MANIFEST_VERSIONS = frozenset({LEGACY_SNAPSHOT_VERSION, INTERNAL_RELEASE})
SNAPSHOT_COMPATIBILITY = {
    (LEGACY_SNAPSHOT_VERSION, None),
    (LEGACY_SNAPSHOT_VERSION, SNAPSHOT_FORMAT),
    (INTERNAL_RELEASE, SNAPSHOT_FORMAT),
    (VERSION, SNAPSHOT_FORMAT),
}
SNAPSHOT_OPERATIONS = frozenset({'setup', 'upgrade', 'backup', 'token-rotation', 'uninstall', 'restore-recovery'})
# `rollback` undoes the last installation change; the other kinds are never its target.
ROLLBACK_OPERATIONS = frozenset({'setup', 'upgrade'})
PACKAGE_FILES = ('novel_tts.py', 'nlr_config.py', 'companion_server.py')
# How long the run unit waits for Qwen to become healthy and register the voice. The CLI's
# --ready-timeout (up to 1800 s) is the user-facing bound; killing a slow but alive Qwen
# earlier would restart its cold start (shader compilation) over and over.
LAUNCH_READY_TIMEOUT = 1800


class TransactionState(Enum):
    VALIDATED = 'validated'
    PLANNED = 'planned'
    SNAPSHOTTED = 'snapshotted'
    STAGED = 'staged'
    STOPPED = 'stopped'
    SWAPPED = 'swapped'
    RELOADED = 'reloaded'
    STARTED = 'started'
    READY = 'ready'
    COMMITTED = 'committed'
    ROLLED_BACK = 'rolled_back'


FAILURE_STAGE_CODES = {
    'validation': 'NLR_UPGRADE_VALIDATION_FAILED',
    'planning': 'NLR_UPGRADE_PLAN_FAILED',
    'snapshot': 'NLR_UPGRADE_SNAPSHOT_FAILED',
    'staging': 'NLR_UPGRADE_STAGING_FAILED',
    'stop_units': 'NLR_UPGRADE_STOP_FAILED',
    'prepare_cache': 'NLR_CACHE_DIR_FAILED',
    'replace_application': 'NLR_UPGRADE_SWAP_FAILED',
    'replace_configuration': 'NLR_UPGRADE_SWAP_FAILED',
    'replace_units': 'NLR_UPGRADE_SWAP_FAILED',
    'replace_launcher': 'NLR_UPGRADE_SWAP_FAILED',
    'daemon_reload': 'NLR_UPGRADE_RELOAD_FAILED',
    'unit_enablement': 'NLR_UPGRADE_UNIT_STATE_FAILED',
    'unit_start': 'NLR_UPGRADE_UNIT_STATE_FAILED',
    'unit_state_verification': 'NLR_UPGRADE_UNIT_STATE_FAILED',
    'readiness': 'NLR_READINESS_FAILED',
    'rollback': 'NLR_ROLLBACK_PARTIAL',
    'transaction': 'NLR_TRANSACTION_FAILED',
    'restore': 'NLR_RESTORE_FAILED',
    'uninstall': 'NLR_UNINSTALL_FAILED',
}
SAFE_FAILURE_CODES = frozenset(FAILURE_STAGE_CODES.values()) | {
    'NLR_QWEN_PORT_CONFLICT',
    'NLR_QWEN_API_REJECTED',
    'NLR_QWEN_PROCESS_UNVERIFIED',
    'NLR_QWEN_PROCESS_EXITED',
    'NLR_QWEN_VOICE_API_UNAVAILABLE',
    'NLR_VOICE_PAYLOAD_INVALID',
    'NLR_VOICE_REGISTRATION_FAILED',
    'NLR_VOICE_REGISTRATION_REJECTED',
    'NLR_VOICE_NOT_CONFIRMED',
    'NLR_CACHE_HEALTH_FAILED',
    'NLR_READINESS_TIMEOUT',
    'NLR_READINESS_HTTP_FAILURE',
}


class ReadinessFailure(ValueError):
    """A stable, redacted failure code for Qwen/companion readiness checks."""

    def __init__(self, code, message):
        self.diagnostic_code = code if code in SAFE_FAILURE_CODES else 'NLR_READINESS_FAILED'
        super().__init__(message)


class TransactionFailure(RuntimeError):
    """Preserve causes internally while exposing only safe stage/code metadata."""

    def __init__(self, original, rollback_error=None, *, stage='transaction', rollback_status=None):
        self.original = original
        self.rollback_error = rollback_error
        self.stage = stage if stage in FAILURE_STAGE_CODES else 'transaction'
        if rollback_status is None:
            rollback_status = 'partial' if rollback_error else 'unknown'
        self.rollback_status = rollback_status if rollback_status in {
            'not-needed', 'not-started', 'complete', 'partial', 'unknown'
        } else 'unknown'
        code = getattr(original, 'diagnostic_code', None)
        if self.rollback_status == 'partial':
            code = 'NLR_ROLLBACK_PARTIAL'
        elif code not in SAFE_FAILURE_CODES:
            code = FAILURE_STAGE_CODES[self.stage]
        self.code = code
        super().__init__(self.safe_message())

    def public_detail(self):
        return {
            'code': self.code,
            'stage': self.stage,
            'rollback': self.rollback_status,
            'message': 'A operação falhou; detalhes sensíveis foram omitidos.',
        }

    def safe_message(self):
        return (
            f'Falha controlada: código {self.code}; etapa {self.stage}; '
            f'recuperação {self.rollback_status}.'
        )


class QwenPortConflict(ValueError):
    """The configured Qwen endpoint is occupied by a process we did not start."""

    diagnostic_code = 'NLR_QWEN_PORT_CONFLICT'


def systemctl(*args, check=True):
    return subprocess.run(['systemctl', '--user', *args], check=check, text=True, capture_output=True)


def parse_unit(text):
    values = {}
    for line in text.replace('\\\n', '').splitlines():
        if '=' in line and not line.lstrip().startswith(('#', ';')):
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip()
    return values


def existing_preferences():
    if not CONFIG_PATH.exists():
        return {}
    try:
        data = json.loads(CONFIG_PATH.read_text())
    except (OSError, ValueError):
        return {}
    preferences = {
        key: data[key] for key in ('token', 'cache_dir', 'cache_limit_mb', 'data_root') if key in data
    }
    if data.get('schema') in (2, 3):
        preferences['require_mount'] = data.get('require_mount', data.get('schema') == 2)
    return preferences


def required_path(value, label):
    if not isinstance(value, (str, os.PathLike)) or not str(value).strip():
        raise ValueError(f'Informe {label}. Nenhum recurso é baixado automaticamente.')
    return Path(value).expanduser().resolve()


def build_config(root=None, qwen_root=None, server=None, model=None, codec=None,
                 voice_name=None, voice_spk=None, voice_rvq=None, voice_text=None,
                 language='English', qwen_port=8080, cache_dir=None,
                 cache_limit_mb=None, require_mount=None, previous=None):
    """Build a portable schema 3 configuration without probing personal paths."""
    previous = previous or {}
    qwen_root = required_path(qwen_root, '--qwen-root')
    server = Path(server).expanduser().resolve() if server else qwen_root / 'build/tts-server'
    model = required_path(model, '--model')
    codec = required_path(codec, '--codec')
    voice_spk = required_path(voice_spk, '--voice-spk')
    voice_rvq = required_path(voice_rvq, '--voice-rvq')
    voice_text = required_path(voice_text, '--voice-text')
    if not isinstance(voice_name, str) or not voice_name or Path(voice_name).name != voice_name or voice_name in ('.', '..'):
        raise ValueError('Use --voice-name com um nome simples, sem caminho.')
    if not isinstance(language, str) or not language.strip():
        raise ValueError('Use --language com um idioma válido.')
    if require_mount is None:
        require_mount = previous.get('require_mount', False)
    if not isinstance(require_mount, bool):
        raise ValueError('require_mount precisa ser verdadeiro ou falso.')
    root = Path(root).expanduser().resolve() if root else Path(previous.get('data_root', '')).expanduser().resolve() if previous.get('data_root') else None
    cache_dir = Path(cache_dir or previous.get('cache_dir') or DEFAULT_CACHE_DIR).expanduser().resolve()
    cache_limit = cache_limit_mb if cache_limit_mb is not None else previous.get('cache_limit_mb', 4096)
    token = previous.get('token') or secrets.token_urlsafe(32)
    return {
        'schema': 3,
        'backend': 'qwen3',
        'mode': 'qwen',
        'data_root': str(root) if root else '',
        'require_mount': require_mount,
        'cache_dir': str(cache_dir),
        'cache_limit_mb': cache_limit,
        'voice': voice_name,
        'token': token,
        'profiles': {
            'qwen': {
                'backend': 'qwen3',
                'cwd': str(qwen_root),
                'argv': [
                    str(server),
                    '--model', str(model),
                    '--codec', str(codec),
                    '--alias', 'qwen3-tts-1.7b-base-q8',
                    '--host', '127.0.0.1',
                    '--port', str(qwen_port),
                    '--lang', language.strip(),
                    '--max-batch', '1',
                ],
                'voices': {
                    voice_name: {
                        'spk': str(voice_spk),
                        'rvq': str(voice_rvq),
                        'text': str(voice_text),
                    },
                },
            },
        },
    }


# Shared by both units. IPAddress* is enforced through cgroup BPF; in user
# scope the kernel may refuse it and log a notice. RestrictAddressFamilies still
# keeps both processes on the local networking families they actually need.
COMMON_SANDBOX = '''UMask=0077
NoNewPrivileges=yes
IPAddressDeny=any
IPAddressAllow=localhost
PrivateTmp=yes
ProtectClock=yes
ProtectControlGroups=yes
ProtectKernelLogs=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
'''

CACHE_SANDBOX = '''ProtectSystem=strict
ProtectHome=read-only
ProtectProc=invisible
PrivateDevices=yes
MemoryDenyWriteExecute=yes
RestrictAddressFamilies=AF_INET AF_UNIX
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
'''

# Qwen needs /dev/dri and executable mappings from the build directory.
TTS_SANDBOX = '''ProtectSystem=full
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
'''


def unit_text(command, description, read_write=()):
    executable = json.dumps(str(APP / 'novel_tts.py').replace('%', '%%'))
    sandbox = COMMON_SANDBOX + (CACHE_SANDBOX if command == 'cache' else TTS_SANDBOX)
    # Quoted so systemd keeps paths with spaces whole; % starts a specifier.
    # UTF-8 stays literal inside the quotes rather than relying on \u escapes.
    sandbox += ''.join(
        f"ReadWritePaths={json.dumps('-' + str(path), ensure_ascii=False).replace('%', '%%')}\n"
        for path in read_write
    )
    return f'''[Unit]
Description={description}
StartLimitIntervalSec=120
StartLimitBurst=3
[Service]
Type=simple
ExecStartPre=/usr/bin/python3 {executable} check
ExecStart=/usr/bin/python3 {executable} {command}
Restart=on-failure
RestartSec=15
TimeoutStartSec=180
TimeoutStopSec=20
{sandbox}Environment=PYTHONUNBUFFERED=1
Environment={json.dumps('NLR_CONFIG_PATH=' + str(CONFIG_PATH).replace('%', '%%'))}
[Install]
WantedBy=default.target
'''


def _remove_owned(path):
    path = Path(path)
    if path.is_symlink() or path.is_file(): path.unlink(missing_ok=True)
    elif path.is_dir(): shutil.rmtree(path)


def _assert_regular_tree(path):
    """Reject links and special files before copying any installation tree into a snapshot."""
    path = Path(path)
    if path.is_symlink():
        raise ValueError(f'Destino administrativo inseguro: {path.name}')
    if not path.exists():
        return
    candidates = path.rglob('*') if path.is_dir() else (path,)
    for candidate in candidates:
        if candidate.is_symlink() or not (candidate.is_file() or candidate.is_dir()):
            raise ValueError('Instalação contém link ou arquivo especial; snapshot recusado.')


class InstallTransaction:
    """Recoverable installer with injectable system and readiness boundaries."""
    def __init__(self, config, *, ctl, ready, source_dir, clock):
        """Build a transaction from explicit side-effect dependencies.

        ``ctl`` and ``ready`` deliberately have no production defaults: callers
        that exercise a transaction directly must provide controlled fakes.
        ``install`` is the sole production boundary that supplies the real
        controller and readiness checker.
        """
        self.config, self.ctl, self.ready = config, ctl, ready
        self.source_dir = Path(source_dir).resolve()
        self.clock = clock
        self.launcher = Path.home() / '.local/bin/novel-tts'
        self.state = None; self.backup = None; self.stage = None; self.states = {}
        self.target_states = None
        self.operation = 'setup'
        self.phase = 'validation'

    def mark(self, state): self.state = state

    def plan(self):
        self.phase = 'validation'
        validate(self.config)
        self.phase = 'planning'
        for name in (SERVICE, CACHE):
            dropin = UNITS / f'{name}.d'
            if dropin.exists() and (dropin.is_symlink() or any(p.name != 'override.conf' for p in dropin.iterdir())):
                raise ValueError(f'Drop-ins adicionais ou inseguros em {dropin}.')
        parent = CONFIG_PATH.parent if CONFIG_PATH.parent.exists() else Path.home()
        if shutil.disk_usage(parent).free < 16 * 1024 * 1024: raise ValueError('Espaço insuficiente para staging e snapshot.')
        self.mark(TransactionState.PLANNED)

    def snapshot(self, operation='setup'):
        self.phase = 'snapshot'
        if operation not in SNAPSHOT_OPERATIONS:
            raise ValueError('Operação de snapshot desconhecida.')
        _assert_regular_tree(APP)
        # Validate and capture the exact managed bytes before creating a
        # snapshot directory. Upgrade, backup, setup and recovery share this
        # ownership boundary; transient bytecode is never copied.
        # Uninstall has a different recovery model: each removed, individually
        # recognized path is held in quarantine and moved back on failure. Its
        # transaction snapshot must not claim ownership of or copy an arbitrary
        # partial application tree.
        app_capture = None if operation == 'uninstall' else _read_owned_application(APP, operation)
        if operation == 'upgrade':
            # Upgrade must preserve only states that systemd reported
            # unambiguously. Unknown/transitional states are not equivalent to
            # inactive/disabled and must not silently become those values.
            self.states = _capture_service_states(self.ctl)
            self.target_states = _validated_states(self.states)
        else:
            # Keep setup's established behavior for installations where the
            # units do not exist yet; restore later validates snapshot data.
            self.states = {
                name: {
                    'active': self.ctl('is-active', name, check=False).stdout.strip() == 'active',
                    'enabled': self.ctl('is-enabled', name, check=False).stdout.strip() == 'enabled',
                }
                for name in (SERVICE, CACHE)
            }
        for name in (SERVICE, CACHE):
            for suffix in ('', '.d'):
                _assert_regular_tree(UNITS / f'{name}{suffix}')
        for source in (CONFIG_PATH, self.launcher):
            _assert_regular_tree(source)
        root = CONFIG_PATH.parent / 'backups'
        stem = self.clock().strftime('%Y%m%d-%H%M%S-%f')
        backup = root / stem
        suffix = 1
        while backup.exists():
            backup = root / f'{stem}-{suffix}'
            suffix += 1
        root.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix='.nlr-snapshot-', dir=root))
        staging.chmod(0o700)
        published = False
        try:
            atomic_json(staging / 'states.json', self.states)
            for name in (SERVICE, CACHE):
                for unit_suffix in ('', '.d'):
                    source = UNITS / f'{name}{unit_suffix}'; target = staging / source.name
                    if source.is_dir(): shutil.copytree(source, target)
                    elif source.exists(): shutil.copy2(source, target)
            for source, target in ((CONFIG_PATH, staging / 'config.json'),
                                   (self.launcher, staging / 'novel-tts')):
                if source.is_dir(): shutil.copytree(source, target)
                elif source.exists(): shutil.copy2(source, target)
            app_present, _legacy_ownership, ignored_bytecode = _copy_owned_application_snapshot(
                APP, staging, app_capture
            )
            if app_present:
                ignored_bytecode = _verify_snapshot_application_source(
                    APP, staging, app_capture, ignored_bytecode
                )
                atomic_json(staging / 'transient-artifacts.json', {
                    'schema': 1, 'ignored_bytecode_count': ignored_bytecode,
                })
            saved_config = staging / 'config.json'
            snapshot_schema = self.config.get('schema')
            if saved_config.is_file():
                try:
                    saved_value = json.loads(saved_config.read_text())
                    if isinstance(saved_value, dict) and saved_value.get('schema') in (2, 3):
                        snapshot_schema = saved_value['schema']
                except (OSError, ValueError, TypeError):
                    pass
            metadata = {
                'operation': operation, 'schema': snapshot_schema,
                'version': VERSION, 'snapshot_format': SNAPSHOT_FORMAT,
                'created_at': self.clock().isoformat(),
                'checksums': _snapshot_checksums(staging),
            }
            atomic_json(staging / 'snapshot.json', metadata)
            _snapshot_metadata(staging)
            if app_present:
                _validate_ownership(staging)
            _validated_states(json.loads((staging / 'states.json').read_text()))
            os.rename(staging, backup)
            published = True
            # Validate the published directory itself before making it
            # discoverable as a complete snapshot.
            _snapshot_metadata(backup)
            if app_present:
                _validate_ownership(backup)
            _validated_states(json.loads((backup / 'states.json').read_text()))
            (backup / 'snapshot-ready').touch()
        except Exception:
            shutil.rmtree(backup if published else staging, ignore_errors=True)
            raise
        self.backup = backup
        self.mark(TransactionState.SNAPSHOTTED)

    def stage_files(self):
        self.phase = 'staging'
        self.stage = Path(tempfile.mkdtemp(prefix='.nlr-stage-', dir=self.backup))
        staged_app = self.stage / 'app'; staged_app.mkdir()
        for name in PACKAGE_FILES:
            source = self.source_dir / name
            if source.is_symlink() or not source.is_file():
                raise ValueError(f'Arquivo do pacote inválido: {name}')
            shutil.copy2(source, staged_app / name)
        digests = {
            name: hashlib.sha256((staged_app / name).read_bytes()).hexdigest()
            for name in PACKAGE_FILES
        }
        package_fingerprint = hashlib.sha256(json.dumps(
            {'version': VERSION, 'files': digests}, sort_keys=True, separators=(',', ':')
        ).encode()).hexdigest()
        atomic_json(staged_app / 'ownership.json', {
            'schema': 1, 'project': APP_NAME, 'version': VERSION,
            'files': sorted((*PACKAGE_FILES, OWNERSHIP_FILE)),
            'package_files_sha256': digests, 'package_fingerprint': package_fingerprint,
        })
        atomic_json(self.stage / 'config.json', self.config)
        writable = {'cache': (self.config['cache_dir'],), 'run': ()}
        for name, command, description in ((SERVICE, 'run', 'Novel TTS Qwen3-TTS'), (CACHE, 'cache', 'Novel TTS authenticated cache')):
            (self.stage / name).write_text(unit_text(command, description, writable[command]))
        launcher = self.stage / 'novel-tts'; launcher.write_text('#!/bin/sh\nexec /usr/bin/python3 ' + shlex.quote(str(APP / 'novel_tts.py')) + ' "$@"\n'); launcher.chmod(0o755)
        self.mark(TransactionState.STAGED)

    def stage_restore(self, snapshot):
        self.stage = Path(tempfile.mkdtemp(prefix='.nlr-stage-', dir=self.backup))
        for name in ('app', 'config.json', SERVICE, CACHE, 'novel-tts'):
            source = snapshot / name
            target = self.stage / name
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                shutil.copy2(source, target)
        for name in (SERVICE, CACHE):
            source = snapshot / f'{name}.d'
            if source.exists():
                shutil.copytree(source, self.stage / source.name)
        self.target_states = _validated_states(json.loads((snapshot / 'states.json').read_text()))
        self.mark(TransactionState.STAGED)

    def swap(self):
        if self.operation == 'upgrade':
            if self.target_states is None:
                raise ValueError('Estados originais das units não foram capturados para o upgrade.')
            states = _validated_states(self.target_states)
        else:
            states = self.target_states or {
                SERVICE: {'enabled': True, 'active': True},
                CACHE: {'enabled': True, 'active': True},
            }
        # Mark before the command: a controller can have stopped one unit before
        # reporting a failure, so recovery must be attempted in that case too.
        self.phase = 'stop_units'
        self.mark(TransactionState.STOPPED); self.ctl('stop', CACHE, SERVICE, check=False)
        APP.parent.mkdir(parents=True, exist_ok=True); CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True); UNITS.mkdir(parents=True, exist_ok=True); self.launcher.parent.mkdir(parents=True, exist_ok=True)
        # The cache unit mounts $HOME read-only and whitelists the cache directory
        # only if it already exists (ReadWritePaths=-...), so create it here.
        self.phase = 'prepare_cache'
        Path(self.config['cache_dir']).mkdir(parents=True, exist_ok=True, mode=0o700)
        self.phase = 'replace_application'
        _remove_owned(APP); shutil.copytree(self.stage / 'app', APP)
        self.phase = 'replace_configuration'
        os.replace(self.stage / 'config.json', CONFIG_PATH)
        self.phase = 'replace_units'
        for name in (SERVICE, CACHE):
            _remove_owned(UNITS / f'{name}.d')
            os.replace(self.stage / name, UNITS / name)
            staged_dropin = self.stage / f'{name}.d'
            if staged_dropin.exists():
                shutil.copytree(staged_dropin, UNITS / staged_dropin.name)
        self.phase = 'replace_launcher'
        _remove_owned(self.launcher); os.replace(self.stage / 'novel-tts', self.launcher)
        self.mark(TransactionState.SWAPPED)
        self.phase = 'daemon_reload'
        self.ctl('daemon-reload'); self.mark(TransactionState.RELOADED)
        self.ctl('reset-failed', SERVICE, CACHE, check=False)
        self.phase = 'unit_enablement'
        self._apply_service_states(states)
        self.mark(TransactionState.STARTED)
        if all(states[name]['active'] for name in (SERVICE, CACHE)):
            self.phase = 'readiness'
            self.ready(self.config)
            self.mark(TransactionState.READY)

    def _apply_service_states(self, states):
        self.phase = 'unit_enablement'
        for name in (SERVICE, CACHE):
            target = states[name]
            self.ctl('enable' if target['enabled'] else 'disable', name)
        self.phase = 'unit_start'
        for name in (CACHE, SERVICE):
            target = states[name]
            if target['active']:
                self.ctl('start', name)
            else:
                self.ctl('stop', name, check=False)
        self.phase = 'unit_state_verification'
        for name in (SERVICE, CACHE):
            active = self.ctl('is-active', name, check=False).stdout.strip() == 'active'
            enabled = self.ctl('is-enabled', name, check=False).stdout.strip() == 'enabled'
            if active != states[name]['active'] or enabled != states[name]['enabled']:
                raise RuntimeError(f'Estado final inesperado para {name}.')

    def restore(self):
        self.phase = 'rollback'
        if not self.backup or not (self.backup / 'snapshot-ready').exists(): raise ValueError('Snapshot incompleto não pode ser restaurado.')
        self.ctl('stop', CACHE, SERVICE, check=False)
        operation = json.loads((self.backup / 'snapshot.json').read_text()).get('operation')
        components = [(CONFIG_PATH, self.backup / 'config.json'),
                      (self.launcher, self.backup / 'novel-tts')]
        if operation != 'uninstall':
            components.insert(1, (APP, self.backup / 'app'))
        for current, saved in components:
            _remove_owned(current)
            if saved.is_dir(): shutil.copytree(saved, current)
            elif saved.exists():
                current.parent.mkdir(parents=True, exist_ok=True)
                if current == CONFIG_PATH:
                    atomic_bytes(current, saved.read_bytes())
                else:
                    shutil.copy2(saved, current)
        for name in (SERVICE, CACHE):
            for suffix in ('', '.d'):
                current = UNITS / f'{name}{suffix}'; saved = self.backup / current.name; _remove_owned(current)
                if saved.is_dir(): shutil.copytree(saved, current)
                elif saved.exists(): current.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(saved, current)
        self.ctl('daemon-reload')
        self._apply_service_states(self.states)
        self.mark(TransactionState.ROLLED_BACK)

    def run(self, operation='setup'):
        self.operation = operation
        try:
            self.mark(TransactionState.VALIDATED)
            self.plan()
            self.snapshot(operation=operation)
            self.stage_files()
            self.swap()
            self.mark(TransactionState.COMMITTED)
            return self.backup
        except Exception as error:
            failure_stage = self.phase
            rollback_error = None
            if self.state in (TransactionState.STOPPED, TransactionState.SWAPPED, TransactionState.RELOADED, TransactionState.STARTED, TransactionState.READY):
                try: self.restore()
                except Exception as failure: rollback_error = failure
                rollback_status = 'partial' if rollback_error else 'complete'
                raise TransactionFailure(error, rollback_error, stage=failure_stage,
                                         rollback_status=rollback_status) from error
            raise
        finally:
            if self.stage: shutil.rmtree(self.stage, ignore_errors=True)


def qwen_endpoint(profile):
    """Return the sole HTTP base URL selected by the active profile."""
    argv = profile.get('argv', [])
    host = option(argv, '--host')
    port = option(argv, '--port')
    if host not in ('127.0.0.1', 'localhost'):
        raise ValueError('O endpoint Qwen precisa usar loopback.')
    try:
        port_number = int(port)
    except (TypeError, ValueError) as error:
        raise ValueError('A porta Qwen do perfil é inválida.') from error
    if not 1024 <= port_number <= 65535:
        raise ValueError('A porta Qwen do perfil é inválida.')
    return f'http://{host}:{port_number}'


def registered_voice_names(payload):
    """Accept the Qwen API's name objects and the older string-only response."""
    if not isinstance(payload, dict) or not isinstance(payload.get('voices'), list):
        raise ValueError('Lista de vozes Qwen incompatível.')
    names = set()
    for item in payload['voices']:
        name = item if isinstance(item, str) else item.get('name') if isinstance(item, dict) else None
        if isinstance(name, str) and name:
            names.add(name)
    return names


def ensure_qwen_port_available(profile):
    """Fail before starting Qwen if another listener already occupies its port."""
    endpoint = qwen_endpoint(profile)
    host, port = endpoint.removeprefix('http://').rsplit(':', 1)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            # A restarted Qwen leaves TIME_WAIT entries on its port for about a
            # minute. SO_REUSEADDR ignores those but still refuses a live listener.
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind((host, int(port)))
    except OSError as error:
        raise ReadinessFailure(
            'NLR_QWEN_PORT_CONFLICT',
            f'Conflito na porta Qwen {port}: ela já está ocupada; o servidor não foi iniciado.'
        ) from error


def _tcp_listener_inodes(port, proc_root=Path('/proc')):
    """Read Linux TCP tables and return all listening socket inodes for a port."""
    inodes = set()
    found_table = False
    try:
        for table_name in ('tcp', 'tcp6'):
            table = Path(proc_root) / 'net' / table_name
            try:
                rows = table.read_text(encoding='ascii').splitlines()[1:]
            except FileNotFoundError:
                continue
            found_table = True
            for row in rows:
                fields = row.split()
                if len(fields) < 10 or fields[3] != '0A':
                    continue
                try:
                    local_port = int(fields[1].rsplit(':', 1)[1], 16)
                except (IndexError, ValueError):
                    continue
                if local_port == int(port):
                    inodes.add(fields[9])
    except OSError:
        return None
    return inodes if found_table else None


def qwen_listener_status(host, port, pids, *, proc_root=Path('/proc')):
    """Return owned, foreign, waiting, or unknown without making an HTTP request."""
    if host not in ('127.0.0.1', 'localhost'):
        return 'unknown'
    inodes = _tcp_listener_inodes(port, proc_root)
    if inodes is None:
        return 'unknown'
    if not inodes:
        return 'waiting'
    if pids is None:
        return 'unknown'  # the caller could not determine the service's processes
    owned = set()
    for pid in pids:
        try:
            fd_dir = Path(proc_root) / str(int(pid)) / 'fd'
            for fd in fd_dir.iterdir():
                try:
                    target = os.readlink(fd)
                except FileNotFoundError:
                    continue
                if target.startswith('socket:[') and target.endswith(']'):
                    owned.add(target[8:-1])
        except FileNotFoundError:
            continue
        except OSError:
            return 'unknown'
    if inodes.issubset(owned):
        return 'owned'
    return 'foreign'


def _child_pids_from_stat(parent_pid, proc_root):
    """Fallback for kernels built without CONFIG_PROC_CHILDREN."""
    wanted = str(parent_pid).encode()
    children = []
    for entry in Path(proc_root).iterdir():
        if not entry.name.isdigit():
            continue
        try:
            # Bytes: a comm cut inside a UTF-8 sequence must not abort the scan.
            raw = (entry / 'stat').read_bytes()
        except OSError:
            continue  # the process exited, or is not ours to read
        # The command is parenthesised and may contain spaces or ')'.
        fields = raw.rsplit(b')', 1)[-1].split()
        if len(fields) > 1 and fields[1] == wanted:
            children.append(int(entry.name))
    return sorted(children)


def qwen_service_child_pids(ctl=None, *, proc_root=Path('/proc')):
    """Find the Qwen child process of the systemd-owned host launcher.

    Returns [] when the service has no main process and None when the children
    cannot be determined, so callers never mistake "unknown" for "none".
    """
    ctl = systemctl if ctl is None else ctl
    try:
        result = ctl('show', SERVICE, '--property=MainPID', '--value', check=False)
        parent_pid = int(result.stdout.strip())
    except (OSError, ValueError, AttributeError, TypeError):
        return None
    if parent_pid <= 1:
        return []
    children = Path(proc_root) / str(parent_pid) / 'task' / str(parent_pid) / 'children'
    try:
        try:
            return [int(value) for value in children.read_text().split()]
        except FileNotFoundError:
            return _child_pids_from_stat(parent_pid, proc_root)
    except (OSError, ValueError):
        return None


def _port_conflict(port):
    return ReadinessFailure(
        'NLR_QWEN_PORT_CONFLICT',
        f'Conflito: porta Qwen {port} ocupada por outro processo; registro cancelado.'
    )


def _retry_delay(deadline, attempt, clock, sleeper):
    """Apply bounded exponential backoff without sleeping past the total deadline."""
    remaining = deadline - clock()
    if remaining <= 0:
        return
    delay = min(0.1 * (2 ** min(attempt, 4)), 1.0, remaining)
    sleeper(delay)


def _http_timeout(deadline, clock):
    return max(0.001, min(2.0, deadline - clock()))


def _check_expected_qwen(process, host, port, probe):
    if process.poll() is not None:
        raise ReadinessFailure(
            'NLR_QWEN_PROCESS_EXITED',
            'O processo Qwen3-TTS encerrou durante a inicialização.',
        )
    ownership = probe(host, port, [process.pid])
    if ownership == 'foreign':
        raise _port_conflict(port)
    if ownership == 'unknown':
        raise ReadinessFailure(
            'NLR_QWEN_PROCESS_UNVERIFIED',
            'Não foi possível confirmar a propriedade do listener Qwen; registro recusado.',
        )
    return ownership


def _raise_permanent_qwen_status(status):
    raise ReadinessFailure(
        'NLR_QWEN_API_REJECTED',
        f'API Qwen incompatível (HTTP {status}); detalhes sensíveis omitidos.',
    )


def wait_ready(config, timeout=240, *, qwen_pids=None, listener_probe=None, opener=None,
               ctl=None, clock=None, sleeper=None):
    """Require Qwen health, exact voice-list membership, and authenticated cache health."""
    profile = active_profile(config)
    endpoint = qwen_endpoint(profile)
    host = option(profile['argv'], '--host')
    port = int(option(profile['argv'], '--port'))
    ctl = systemctl if ctl is None else ctl
    probe = qwen_listener_status if listener_probe is None else listener_probe
    open_url = urllib.request.urlopen if opener is None else opener
    clock = time.monotonic if clock is None else clock
    sleeper = time.sleep if sleeper is None else sleeper
    deadline = clock() + max(0, timeout)
    attempt = 0
    last_code = 'NLR_QWEN_VOICE_API_UNAVAILABLE'
    last_message = 'API de vozes Qwen indisponível.'
    health_ready = False
    while clock() < deadline:
        expected_pids = qwen_service_child_pids(ctl) if qwen_pids is None else qwen_pids
        ownership = probe(host, port, expected_pids)
        if ownership == 'foreign':
            raise _port_conflict(port)
        if ownership == 'unknown':
            raise ReadinessFailure(
                'NLR_QWEN_PROCESS_UNVERIFIED',
                f'Não foi possível confirmar o processo Qwen na porta {port}; prontidão recusada.',
            )
        if ownership != 'owned':
            _retry_delay(deadline, attempt, clock, sleeper)
            attempt += 1
            continue

        if not health_ready:
            try:
                with open_url(endpoint + '/health', timeout=_http_timeout(deadline, clock)) as response:
                    status = getattr(response, 'status', 200)
                _assert_listener_still_owned(host, port, expected_pids, probe)
                if status == 200:
                    health_ready = True
                elif status == 404 or status >= 500:
                    last_code = 'NLR_QWEN_VOICE_API_UNAVAILABLE'
                    last_message = 'API de vozes Qwen indisponível.'
                else:
                    _raise_permanent_qwen_status(status)
            except urllib.error.HTTPError as error:
                status = error.code
                error.close()
                _assert_listener_still_owned(host, port, expected_pids, probe)
                if status == 404 or status >= 500:
                    last_code = 'NLR_QWEN_VOICE_API_UNAVAILABLE'
                    last_message = 'API de vozes Qwen indisponível.'
                else:
                    _raise_permanent_qwen_status(status)
            except ReadinessFailure:
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
                last_code = 'NLR_QWEN_VOICE_API_UNAVAILABLE'
                last_message = 'API de vozes Qwen indisponível.'
            if not health_ready:
                _retry_delay(deadline, attempt, clock, sleeper)
                attempt += 1
                continue

        try:
            with open_url(endpoint + '/v1/audio/voices', timeout=_http_timeout(deadline, clock)) as response:
                status = getattr(response, 'status', 200)
                payload = json.load(response) if status == 200 else None
            _assert_listener_still_owned(host, port, expected_pids, probe)
            voices = registered_voice_names(payload) if status == 200 else set()
            if status == 404 or status == 409 or status >= 500:
                last_code = 'NLR_QWEN_VOICE_API_UNAVAILABLE'
                last_message = 'API de vozes Qwen indisponível.'
            elif status != 200:
                _raise_permanent_qwen_status(status)
            elif config['voice'] not in voices:
                last_code = 'NLR_VOICE_NOT_CONFIRMED'
                last_message = 'A voz configurada ainda não foi confirmada pela API Qwen.'
            else:
                headers = {'Authorization': 'Bearer ' + config['token']}
                for path in ('/health', '/identity'):
                    with open_url(urllib.request.Request('http://127.0.0.1:8081' + path, headers=headers),
                                  timeout=_http_timeout(deadline, clock)) as cache_response:
                        cache_status = getattr(cache_response, 'status', 200)
                        if cache_status != 200:
                            if cache_status >= 500:
                                raise urllib.error.HTTPError(
                                    cache_response.geturl() if hasattr(cache_response, 'geturl') else '',
                                    cache_status, 'cache unavailable', getattr(cache_response, 'headers', {}), None,
                                )
                            raise ReadinessFailure(
                                'NLR_CACHE_HEALTH_FAILED', 'Cache autenticado indisponível.'
                            )
                    _assert_listener_still_owned(host, port, expected_pids, probe)
                return
        except urllib.error.HTTPError as error:
            status = error.code
            is_qwen = error.url is None or error.url.startswith(endpoint)
            error.close()
            if not is_qwen:
                if status in (401, 403) or status < 500:
                    raise ReadinessFailure(
                        'NLR_CACHE_HEALTH_FAILED', 'Cache autenticado indisponível.'
                    ) from None
                last_code = 'NLR_CACHE_HEALTH_FAILED'
                last_message = 'Cache autenticado indisponível.'
            else:
                _assert_listener_still_owned(host, port, expected_pids, probe)
                if status in (404, 409) or status >= 500:
                    last_code = 'NLR_QWEN_VOICE_API_UNAVAILABLE'
                    last_message = 'API de vozes Qwen indisponível.'
                else:
                    _raise_permanent_qwen_status(status)
        except ReadinessFailure:
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError,
                ValueError, json.JSONDecodeError):
            last_code = 'NLR_QWEN_VOICE_API_UNAVAILABLE'
            last_message = 'API de vozes Qwen indisponível.'
        _retry_delay(deadline, attempt, clock, sleeper)
        attempt += 1
    raise ReadinessFailure(last_code, last_message)


def _assert_listener_still_owned(host, port, pids, probe):
    ownership = probe(host, port, pids)
    if ownership == 'foreign':
        raise _port_conflict(port)
    if ownership != 'owned':
        raise ReadinessFailure(
            'NLR_QWEN_PROCESS_UNVERIFIED',
            'A propriedade do listener Qwen mudou durante a prontidão.',
        )


def install(root=None, *, ctl=None, ready=None, source_dir=None, clock=None, **overrides):
    config = build_config(root, previous=existing_preferences(), **overrides)
    transaction = InstallTransaction(
        config,
        ctl=systemctl if ctl is None else ctl,
        ready=wait_ready if ready is None else ready,
        source_dir=Path(__file__).resolve().parent if source_dir is None else source_dir,
        clock=datetime.now if clock is None else clock,
    )
    backup = transaction.run()
    print(f'Qwen3-TTS instalado. Backup: {backup}\nPareamento: ~/.local/bin/novel-tts token\nDiagnóstico: ~/.local/bin/novel-tts doctor')


def public_config(config):
    """Stable CLI representation that never carries credentials or voice text."""
    profile = active_profile(config)
    return {
        'schema': configuration_schema(config), 'backend': config['backend'],
        'mode': config['mode'], 'voice': config['voice'],
        'cache_dir': config['cache_dir'], 'qwen_port': option(profile['argv'], '--port'),
    }


def install_plan(config, operation='setup'):
    """Pure, redacted description shared by plan and dry-run setup."""
    return {
        'operation': operation, 'version': VERSION, 'configuration': public_config(config),
        'changes': ['application', 'configuration', 'systemd_units', 'launcher'],
        'requires_confirmation': operation in ('setup', 'upgrade', 'restore'),
    }


def upgrade_plan(config, *, migrated_from=None, source_dir=None):
    source_dir = Path(__file__).resolve().parent if source_dir is None else Path(source_dir)
    if installed_package_matches(config, source_dir):
        return {'operation': 'upgrade', 'schema': configuration_schema(config),
                'changes': [], 'idempotent': True,
                **({'migration': {'from_schema': migrated_from, 'to_schema': 3}} if migrated_from else {})}
    expected = package_payloads(config, source_dir)
    changes = []
    if any(_component_bytes(APP / file) != {'': expected[f'app/{file}']} for file in PACKAGE_FILES):
        changes.append('application')
    try:
        ownership = json.loads((APP / OWNERSHIP_FILE).read_text())
        expected_hashes = {
            name: hashlib.sha256(expected[f'app/{name}']).hexdigest()
            for name in PACKAGE_FILES
        }
        fingerprint = hashlib.sha256(json.dumps(
            {'version': VERSION, 'files': expected_hashes}, sort_keys=True, separators=(',', ':')
        ).encode()).hexdigest()
        if ownership.get('package_fingerprint') != fingerprint:
            if 'application' not in changes:
                changes.append('application')
    except (OSError, ValueError, AttributeError):
        if 'application' not in changes:
            changes.append('application')
    for name in (SERVICE, CACHE):
        if _component_bytes(UNITS / name) != {'': expected[f'units/{name}']}:
            if 'systemd_units' not in changes:
                changes.append('systemd_units')
    launcher = Path.home() / '.local/bin/novel-tts'
    if _component_bytes(launcher) != {'': expected['launcher/novel-tts']}:
        changes.append('launcher')
    try:
        if json.loads(CONFIG_PATH.read_text()) != config:
            changes.append('configuration')
    except (OSError, ValueError):
        changes.append('configuration')
    result = {'operation': 'upgrade', 'schema': configuration_schema(config),
              'changes': changes or ['application'], 'idempotent': False}
    if migrated_from:
        result['migration'] = {'from_schema': migrated_from, 'to_schema': 3}
    return result


OWNERSHIP_FILE = 'ownership.json'
OWNED_APP_FILES = frozenset({'novel_tts.py', 'nlr_config.py', 'companion_server.py', OWNERSHIP_FILE})
OWNED_OVERRIDE_TEXT = '# Novel Local Reader managed override\n[Service]\n'
MAX_TRANSIENT_BYTECODE_FILES = 12
MAX_TRANSIENT_BYTECODE_BYTES = 16 * 1024 * 1024
MAX_TRANSIENT_BYTECODE_FILE_BYTES = 4 * 1024 * 1024


def _transient_bytecode_count(app, package_files):
    """Classify only direct CPython bytecode for known package modules."""
    app = Path(app)
    if app.is_symlink() or not app.is_dir():
        raise ValueError('Aplicação instalada insegura.')
    allowed = set(package_files)
    entries = list(app.iterdir())
    unexpected = {entry.name for entry in entries} - allowed - {'__pycache__'}
    if unexpected or not allowed.issubset({entry.name for entry in entries}):
        raise ValueError('Aplicação contém arquivos ausentes ou inesperados.')
    for name in allowed:
        entry = app / name
        if entry.is_symlink() or not entry.is_file():
            raise ValueError('Arquivo do pacote inseguro.')
    cache = app / '__pycache__'
    if not cache.exists() and not cache.is_symlink():
        return 0
    if cache.is_symlink() or not cache.is_dir():
        raise ValueError('Diretório de bytecode inseguro.')
    stems = {Path(name).stem for name in PACKAGE_FILES}
    pattern = re.compile(r'([A-Za-z_][A-Za-z_0-9]*)\.cpython-[0-9]{2,3}(?:\.opt-[0-2])?\.pyc\Z')
    count = total = 0
    for item in cache.iterdir():
        match = pattern.fullmatch(item.name)
        mode = item.lstat().st_mode
        if not match or match.group(1) not in stems or not stat.S_ISREG(mode):
            raise ValueError('Bytecode transitório inesperado ou inseguro.')
        count += 1
        size = item.stat().st_size
        total += size
        if (count > MAX_TRANSIENT_BYTECODE_FILES or size > MAX_TRANSIENT_BYTECODE_FILE_BYTES or
                total > MAX_TRANSIENT_BYTECODE_BYTES):
            raise ValueError('Bytecode transitório excede o limite conservador.')
        if not _valid_transient_bytecode(item):
            raise ValueError('Bytecode transitório inválido.')
    return count


def _valid_transient_bytecode(path):
    """Accept a CPython bytecode cache: fully checked for this interpreter, shape-checked otherwise."""
    try:
        data = Path(path).read_bytes()
        if len(data) < 16 or data[2:4] != b'\r\n':  # every CPython magic number ends in \r\n
            return False
        if int.from_bytes(data[4:8], 'little') not in (0, 1, 3):
            return False
        if data[:4] != importlib.util.MAGIC_NUMBER:
            # Left by another Python minor version (an interpreter upgrade, a venv).
            # It is never copied or executed, so the header shape is enough.
            return True
        return isinstance(marshal.loads(data[16:]), types.CodeType)
    except (OSError, EOFError, ValueError, TypeError, OverflowError):
        return False


def _installed_app_payloads(app, *, legacy=False):
    """Read only recognized package bytes; never return transient bytecode."""
    names = PACKAGE_FILES if legacy else (*PACKAGE_FILES, OWNERSHIP_FILE)
    ignored = _transient_bytecode_count(app, names)
    payloads = {name: (Path(app) / name).read_bytes() for name in names}
    return payloads, ignored


def _read_owned_application(app, operation):
    """Validate and capture the managed application before snapshot staging."""
    app = Path(app)
    if app.is_symlink():
        raise ValueError('Aplicação instalada insegura.')
    if not app.exists():
        if operation == 'upgrade':
            raise ValueError('Aplicação anterior ausente; upgrade recusado.')
        if operation in ('backup', 'token-rotation'):
            raise ValueError('Aplicação ausente; backup explícito recusado.')
        return None
    if not app.is_dir():
        raise ValueError('Aplicação instalada insegura.')

    marker = app / OWNERSHIP_FILE
    if marker.exists() or marker.is_symlink():
        payloads, ignored = _installed_app_payloads(app)
        _validate_installed_manifest(payloads)
        return {'payloads': payloads, 'legacy': None, 'ignored': ignored}

    legacy = _recognized_legacy_ownership(app)
    if legacy is None:
        raise ValueError('Aplicação instalada não pertence a um pacote reconhecido.')
    payloads, ignored = _installed_app_payloads(app, legacy=True)
    return {'payloads': payloads, 'legacy': legacy, 'ignored': ignored}


def _copy_owned_application_snapshot(app, staging, initial):
    """Copy managed bytes only, then revalidate source and staged ownership."""
    if initial is None:
        return False, None, 0

    app = Path(app)
    payloads = initial['payloads']
    legacy = initial['legacy']
    staging_app = Path(staging) / 'app'
    staging_app.mkdir()
    for name, data in payloads.items():
        atomic_bytes(staging_app / name, data)
    ignored = _verify_snapshot_application_source(app, staging, initial, initial['ignored'])
    atomic_json(Path(staging) / 'transient-artifacts.json', {
        'schema': 1, 'ignored_bytecode_count': ignored,
    })
    if legacy is not None:
        atomic_json(Path(staging) / 'legacy-ownership.json', legacy)
    return True, legacy, ignored


def _verify_snapshot_application_source(app, staging, capture, ignored_before):
    """Recheck source ownership and staged bytes at both sides of the copy."""
    payloads = capture['payloads']
    legacy = capture['legacy']
    source_after, ignored_after = _installed_app_payloads(app, legacy=legacy is not None)
    if source_after != payloads:
        raise ValueError('Aplicação mudou durante a criação do snapshot.')
    if legacy is not None:
        if _recognized_legacy_ownership(app) != legacy:
            raise ValueError('Ownership legado mudou durante a criação do snapshot.')
    else:
        _validate_installed_manifest(source_after)

    staging_app = Path(staging) / 'app'
    staged_names = {entry.name for entry in staging_app.iterdir()}
    if staged_names != set(payloads):
        raise ValueError('Cópia administrada do snapshot incompleta.')
    for name, data in payloads.items():
        target = staging_app / name
        if target.is_symlink() or not target.is_file() or target.read_bytes() != data:
            raise ValueError('Cópia administrada do snapshot não confere.')
    return max(ignored_before, ignored_after)


def _validate_installed_manifest(payloads):
    try:
        marker = json.loads(payloads[OWNERSHIP_FILE])
        digests = {name: hashlib.sha256(payloads[name]).hexdigest() for name in PACKAGE_FILES}
        fingerprint = hashlib.sha256(json.dumps(
            {'version': marker['version'], 'files': digests}, sort_keys=True, separators=(',', ':')
        ).encode()).hexdigest()
        if (marker.get('schema') != 1 or marker.get('project') != APP_NAME or
                marker.get('version') not in PREVIOUS_MANIFEST_VERSIONS | {VERSION} or
                marker.get('files') != sorted(OWNED_APP_FILES) or
                marker.get('package_files_sha256') != digests or
                marker.get('package_fingerprint') != fingerprint):
            raise ValueError('Manifesto de propriedade instalado não confere.')
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError('Manifesto de propriedade instalado não confere.') from error

# Complete file tuples from the two known pre-manifest 1.4.0 host trees.
# Unknown or edited legacy packages are deliberately not promoted to owned snapshots.
LEGACY_APP_DIGESTS = frozenset({
    ('3920b3d32dd49b498b245a13a770d502cfd4a08a5f733866070d2b900980b68b',
     '941a7ad31da1ed1d1c3ac2ca953db38734397a2ad9d699552866ad58844bf843',
     'dfd9d6d04df205aafeb96b404abfe967f6a63969741e8b6a40b795a57a22dde4'),
    ('4c505b341e721dc5f8ae3693acc936518bfb7a1d42d94c43c6d3224bed664e55',
     '941a7ad31da1ed1d1c3ac2ca953db38734397a2ad9d699552866ad58844bf843',
     'dfd9d6d04df205aafeb96b404abfe967f6a63969741e8b6a40b795a57a22dde4'),
})


def _recognized_legacy_ownership(app=None, units=None, launcher=None):
    """Recognize an exact, unmodified pre-manifest application before upgrade."""
    app = APP if app is None else Path(app)
    units = UNITS if units is None else Path(units)
    launcher = Path.home() / '.local/bin/novel-tts' if launcher is None else Path(launcher)
    payloads, _ignored = _installed_app_payloads(app, legacy=True)
    digests = {name: hashlib.sha256(payloads[name]).hexdigest() for name in PACKAGE_FILES}
    if tuple(digests[name] for name in PACKAGE_FILES) not in LEGACY_APP_DIGESTS:
        raise ValueError('Aplicação legada não corresponde a um pacote conhecido.')
    if not _owned_launcher(launcher) or not all(
        _owned_unit(units / name, command) for name, command in ((SERVICE, 'run'), (CACHE, 'cache'))
    ):
        raise ValueError('Launcher ou units legados não reconhecidos.')
    fingerprint = hashlib.sha256(json.dumps(
        {'version': LEGACY_SNAPSHOT_VERSION, 'files': digests}, sort_keys=True, separators=(',', ':')
    ).encode()).hexdigest()
    return {
        'schema': 1, 'project': APP_NAME, 'version': LEGACY_SNAPSHOT_VERSION,
        'files': sorted(OWNED_APP_FILES), 'package_files_sha256': digests,
        'package_fingerprint': fingerprint,
    }


def package_payloads(config, source_dir):
    """Return exact package-managed bytes, excluding configuration and private assets."""
    source_dir = Path(source_dir)
    payloads = {f'app/{name}': (source_dir / name).read_bytes() for name in PACKAGE_FILES}
    writable = {'cache': (config['cache_dir'],), 'run': ()}
    for name, command, description in (
        (SERVICE, 'run', 'Novel TTS Qwen3-TTS'),
        (CACHE, 'cache', 'Novel TTS authenticated cache'),
    ):
        payloads[f'units/{name}'] = unit_text(command, description, writable[command]).encode()
    script = '#!/bin/sh\nexec /usr/bin/python3 ' + shlex.quote(str(APP / 'novel_tts.py')) + ' "$@"\n'
    payloads['launcher/novel-tts'] = script.encode()
    return payloads


def installed_package_matches(config, source_dir):
    """Compare installed package-managed bytes and configuration, never schema alone."""
    try:
        if json.loads(CONFIG_PATH.read_text()) != config:
            return False
        ownership = json.loads((APP / OWNERSHIP_FILE).read_text())
        if (ownership.get('schema') != 1 or ownership.get('project') != APP_NAME or
                ownership.get('version') != VERSION or
                set(ownership.get('files', ())) != OWNED_APP_FILES):
            return False
        payloads = package_payloads(config, source_dir)
        expected = {
            name: hashlib.sha256(payloads[f'app/{name}']).hexdigest()
            for name in PACKAGE_FILES
        }
        if ownership.get('package_files_sha256') != expected:
            return False
        fingerprint = hashlib.sha256(json.dumps(
            {'version': VERSION, 'files': expected}, sort_keys=True, separators=(',', ':')
        ).encode()).hexdigest()
        if ownership.get('package_fingerprint') != fingerprint:
            return False
        for relative, data in payloads.items():
            if relative.startswith('app/'):
                installed = APP / relative.removeprefix('app/')
            elif relative.startswith('units/'):
                installed = UNITS / relative.removeprefix('units/')
            else:
                installed = Path.home() / '.local/bin/novel-tts'
            if installed.is_symlink() or not installed.is_file() or installed.read_bytes() != data:
                return False
        return True
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def _capture_service_states(ctl):
    """Capture complete, unambiguous states for both managed systemd units."""
    states = {}
    for name in (SERVICE, CACHE):
        try:
            active_result = ctl('is-active', name, check=False)
            enabled_result = ctl('is-enabled', name, check=False)
            active_text = active_result.stdout.strip()
            enabled_text = enabled_result.stdout.strip()
        except Exception as error:
            raise ValueError('Não foi possível capturar os estados atuais das units.') from error
        if active_text not in ('active', 'inactive') or enabled_text not in ('enabled', 'disabled'):
            raise ValueError('A captura dos estados das units está incompleta ou ambígua.')
        states[name] = {
            'active': active_text == 'active',
            'enabled': enabled_text == 'enabled',
        }
    return _validated_states(states)


def _validated_states(states):
    if not isinstance(states, dict):
        raise ValueError('Estados do snapshot inválidos.')
    result = {}
    for name in (SERVICE, CACHE):
        item = states.get(name)
        if (not isinstance(item, dict) or type(item.get('active')) is not bool or
                type(item.get('enabled')) is not bool):
            raise ValueError('Estados do snapshot inválidos.')
        result[name] = {'active': item['active'], 'enabled': item['enabled']}
    if set(states) != {SERVICE, CACHE}:
        raise ValueError('Estados do snapshot inválidos.')
    return result


def _snapshot_checksums(snapshot):
    """Hash all snapshot payload files while rejecting links and special files."""
    snapshot = Path(snapshot)
    checksums = {}
    for path in sorted(snapshot.rglob('*')):
        if path.name in ('snapshot.json', 'snapshot-ready') and path.parent == snapshot:
            continue
        if path.is_symlink():
            raise ValueError('Snapshot contém link simbólico.')
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError('Snapshot contém arquivo especial.')
        relative = path.relative_to(snapshot).as_posix()
        checksums[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return checksums


def _validate_ownership(snapshot):
    app = Path(snapshot) / 'app'
    marker_path = app / OWNERSHIP_FILE
    evidence_path = Path(snapshot) / 'legacy-ownership.json'
    if not marker_path.exists() and evidence_path.is_file() and not evidence_path.is_symlink():
        metadata = json.loads((Path(snapshot) / 'snapshot.json').read_text())
        if (metadata.get('operation') not in SNAPSHOT_OPERATIONS or metadata.get('version') not in (INTERNAL_RELEASE, VERSION) or
                metadata.get('snapshot_format') != SNAPSHOT_FORMAT):
            raise ValueError('Evidência de propriedade legada incompatível.')
        expected = _recognized_legacy_ownership(app, snapshot, Path(snapshot) / 'novel-tts')
        if json.loads(evidence_path.read_text()) != expected:
            raise ValueError('Evidência de propriedade legada não confere.')
        return
    if evidence_path.exists() or marker_path.is_symlink() or not marker_path.is_file():
        raise ValueError('Manifesto de propriedade do snapshot ausente ou inválido.')
    marker = json.loads(marker_path.read_text())
    if not isinstance(marker, dict):
        raise ValueError('Manifesto de propriedade do snapshot inválido.')
    files = marker.get('files')
    if (marker.get('schema') != 1 or marker.get('project') != APP_NAME or
            not isinstance(marker.get('version'), str) or not isinstance(files, list) or
            any(not isinstance(item, str) or Path(item).name != item or item in ('.', '..') for item in files) or
            set(files) != OWNED_APP_FILES):
        raise ValueError('Manifesto de propriedade do snapshot inválido.')
    if {p.name for p in app.iterdir()} != OWNED_APP_FILES:
        raise ValueError('Arquivos da aplicação no snapshot não conferem.')
    digests = {
        name: hashlib.sha256((app / name).read_bytes()).hexdigest()
        for name in PACKAGE_FILES
    }
    fingerprint = hashlib.sha256(json.dumps(
        {'version': marker['version'], 'files': digests}, sort_keys=True, separators=(',', ':')
    ).encode()).hexdigest()
    if (marker.get('package_files_sha256') != digests or
            marker.get('package_fingerprint') != fingerprint):
        raise ValueError('Integridade da aplicação no snapshot não confere.')


def _snapshot_file_inventory(snapshot):
    snapshot = Path(snapshot)
    files = set()
    for path in snapshot.rglob('*'):
        if path.is_symlink():
            raise ValueError('Snapshot contém link simbólico.')
        if path.is_file() and not (
            path.parent == snapshot and path.name in ('snapshot.json', 'snapshot-ready')
        ):
            files.add(path.relative_to(snapshot).as_posix())
        elif not path.is_file() and not path.is_dir():
            raise ValueError('Snapshot contém arquivo especial.')
    return files


def _snapshot_metadata(snapshot):
    metadata = json.loads((Path(snapshot) / 'snapshot.json').read_text())
    if not isinstance(metadata, dict):
        raise ValueError('Metadados de snapshot inválidos.')
    version = metadata.get('version')
    snapshot_format = metadata.get('snapshot_format')
    if (version, snapshot_format) not in SNAPSHOT_COMPATIBILITY:
        raise ValueError('metadados incompatíveis')
    inventory = _snapshot_file_inventory(snapshot)
    transient_record = Path(snapshot) / 'transient-artifacts.json'
    if transient_record.exists():
        record = json.loads(transient_record.read_text())
        if (not isinstance(record, dict) or set(record) != {'schema', 'ignored_bytecode_count'} or
                record['schema'] != 1 or type(record['ignored_bytecode_count']) is not int or
                not 0 <= record['ignored_bytecode_count'] <= MAX_TRANSIENT_BYTECODE_FILES or
                any('__pycache__' in Path(name).parts or name.endswith('.pyc') for name in inventory)):
            raise ValueError('Evidência de artefatos transitórios inválida.')
    checksums = metadata.get('checksums')
    if snapshot_format is None:
        # Only the known 1.4.0 pre-checksum layout is admitted as legacy.
        if 'snapshot_format' in metadata or 'checksums' in metadata:
            raise ValueError('Formato legado de snapshot inconsistente.')
    else:
        if not isinstance(checksums, dict) or set(checksums) != inventory:
            raise ValueError('Manifesto de integridade incompleto ou inconsistente.')
        actual = _snapshot_checksums(snapshot)
        if checksums != actual:
            raise ValueError('Checksum de integridade do snapshot não confere.')
    return metadata


def _component_bytes(path):
    path = Path(path)
    if path.is_symlink():
        raise ValueError('Alvo de instalação contém link simbólico.')
    if not path.exists():
        return None
    if path.is_file():
        return {'': path.read_bytes()}
    if path.is_dir():
        result = {}
        for child in sorted(path.rglob('*')):
            if child.is_symlink():
                raise ValueError('Alvo de instalação contém link simbólico.')
            if child.is_file():
                result[child.relative_to(path).as_posix()] = child.read_bytes()
        return result
    raise ValueError('Alvo de instalação não é arquivo regular ou diretório.')


def _snapshot_app_version(snapshot):
    """Version of the application bytes inside a snapshot, or None if it cannot be told."""
    for relative in (Path('app') / OWNERSHIP_FILE, Path('legacy-ownership.json')):
        try:
            version = json.loads((Path(snapshot) / relative).read_text()).get('version')
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(version, str):
            return version
    return None


def restore_plan(snapshot_id):
    snapshot, target_config = validated_backup(snapshot_id)
    current = {
        'application': _component_bytes(APP),
        'configuration': _component_bytes(CONFIG_PATH),
        'launcher': _component_bytes(Path.home() / '.local/bin/novel-tts'),
        'systemd_units': {
            name: _component_bytes(UNITS / name) for name in (SERVICE, CACHE)
        } | {
            f'{name}.d': _component_bytes(UNITS / f'{name}.d') for name in (SERVICE, CACHE)
        },
    }
    desired = {
        'application': _component_bytes(snapshot / 'app'),
        'configuration': _component_bytes(snapshot / 'config.json'),
        'launcher': _component_bytes(snapshot / 'novel-tts'),
        'systemd_units': {
            name: _component_bytes(snapshot / name) for name in (SERVICE, CACHE)
        } | {
            f'{name}.d': _component_bytes(snapshot / f'{name}.d') for name in (SERVICE, CACHE)
        },
    }
    changes = [name for name in current if current[name] != desired[name]]
    metadata = json.loads((snapshot / 'snapshot.json').read_text())
    return {
        'operation': 'restore', 'backup_id': snapshot_id,
        'changes': changes, 'configuration_schema': configuration_schema(target_config),
        'snapshot_operation': metadata.get('operation', 'legacy'),
        'snapshot_created_at': metadata.get('created_at'),
        'snapshot_app_version': _snapshot_app_version(snapshot),
        'requires_confirmation': True,
    }


def uninstall_result(**values):
    result = {'planned_removals': [], 'removed': [], 'preserved': [], 'skipped': [], 'conflicts': [],
              'snapshot_id': None, 'rollback_performed': False, 'rollback_status': 'not_started'}
    result.update(values)
    return result


def _owned_launcher(path):
    expected = '#!/bin/sh\nexec /usr/bin/python3 ' + shlex.quote(str(APP / 'novel_tts.py')) + ' "$@"\n'
    return path.is_file() and not path.is_symlink() and path.read_text() == expected


def _owned_unit(path, command):
    if not path.is_file() or path.is_symlink():
        return False
    section = None
    values = {}
    for line in path.read_text().replace('\\\n', '').splitlines():
        line = line.strip()
        if line.startswith('[') and line.endswith(']'):
            section = line[1:-1]
        elif section == 'Service' and '=' in line and not line.startswith(('#', ';')):
            key, value = line.split('=', 1)
            values.setdefault(key.strip(), []).append(value.strip())
    executable = json.dumps(str(APP / 'novel_tts.py').replace('%', '%%'))
    return (values.get('Type') == ['simple'] and
            values.get('ExecStart') == [f'/usr/bin/python3 {executable} {command}'] and
            values.get('ExecStartPre') == [f'/usr/bin/python3 {executable} check'] and
            json.dumps('NLR_CONFIG_PATH=' + str(CONFIG_PATH).replace('%', '%%')) in values.get('Environment', []))


def _owned_override(path):
    return path.is_file() and not path.is_symlink() and path.read_text() == OWNED_OVERRIDE_TEXT


def _validate_manifest(path):
    if not path.exists():
        return None
    if path.is_symlink() or not path.is_file():
        raise ValueError('Manifesto de propriedade inseguro.')
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError('Manifesto de propriedade inválido.')
    files = data.get('files')
    version = data.get('version')
    if (data.get('schema') != 1 or data.get('project') != APP_NAME or
            not isinstance(version, str) or not version or
            not isinstance(files, list) or set(files) != OWNED_APP_FILES or len(files) != len(OWNED_APP_FILES)):
        raise ValueError('Manifesto de propriedade inválido.')
    return data


def _relative_symlinks(root, base):
    """List symlinks below a managed root without following any of them."""
    found = []
    for current, directories, files in os.walk(root, followlinks=False):
        current = Path(current)
        for name in directories + files:
            candidate = current / name
            if candidate.is_symlink():
                found.append(str(candidate.relative_to(base)))
        directories[:] = [name for name in directories if not (current / name).is_symlink()]
    return found


def uninstall_plan():
    """Pure conservative inventory; never follows symlinks or writes."""
    result = uninstall_result()
    home = Path.home()
    launcher = home / '.local/bin/novel-tts'
    expected = {
        'app': XDG_DATA_HOME / APP_NAME,
        'units': CONFIG_PATH.parent.parent / 'systemd/user',
        'launcher': launcher,
    }
    for label, path in (('app', APP), ('units', UNITS), ('launcher', launcher)):
        if not path.is_absolute() or os.path.abspath(path) != os.path.abspath(expected[label]):
            result['conflicts'].append(f'{label}:dangerous_path')
    if result['conflicts']:
        result['conflicts'].sort()
        return result
    if UNITS.is_symlink() or (UNITS.exists() and not UNITS.is_dir()):
        result['conflicts'].append('units:unsafe_root')
        return result
    for path, command in ((UNITS / SERVICE, 'run'), (UNITS / CACHE, 'cache')):
        if path.is_symlink(): result['conflicts'].append(path.name)
        elif path.exists() and _owned_unit(path, command): result['planned_removals'].append(path.name)
        elif path.exists(): result['conflicts'].append(path.name)
        else: result['skipped'].append(path.name)
        dropin = UNITS / f'{path.name}.d' / 'override.conf'
        if dropin.is_symlink(): result['conflicts'].append(str(dropin.relative_to(UNITS)))
        elif dropin.exists() and _owned_override(dropin): result['planned_removals'].append(str(dropin.relative_to(UNITS)))
        elif dropin.exists(): result['conflicts'].append(str(dropin.relative_to(UNITS)))
        else: result['skipped'].append(str(dropin.relative_to(UNITS)))
        dropdir = dropin.parent
        if dropdir.is_symlink():
            result['conflicts'].append(str(dropdir.relative_to(UNITS)))
        elif dropdir.exists():
            for child in dropdir.iterdir():
                relative = str(child.relative_to(UNITS))
                if child.is_symlink(): result['conflicts'].append(relative)
                elif child.name != 'override.conf': result['preserved'].append(relative)
            result['conflicts'].extend(_relative_symlinks(dropdir, UNITS))
    if launcher.is_symlink() or (launcher.exists() and not _owned_launcher(launcher)): result['conflicts'].append('novel-tts')
    elif launcher.exists(): result['planned_removals'].append('novel-tts')
    else: result['skipped'].append('novel-tts')
    if APP.is_symlink() or (APP.exists() and not APP.is_dir()): result['conflicts'].append('app')
    elif APP.exists():
        try: _validate_manifest(APP / OWNERSHIP_FILE)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            result['conflicts'].append(f'manifest:{error}')
        for child in APP.iterdir():
            label = f'app/{child.name}'
            if child.is_symlink(): result['conflicts'].append(label)
            elif child.name in OWNED_APP_FILES and child.is_file(): result['planned_removals'].append(label)
            else: result['preserved'].append(label)
        result['conflicts'].extend(f'app_symlink:{item}' for item in _relative_symlinks(APP, APP))
        for name in OWNED_APP_FILES:
            label = f'app/{name}'
            if not (APP / name).exists() and label not in result['conflicts']:
                result['skipped'].append(label)
    else:
        result['skipped'].append('app')
    if not result['planned_removals'] and not result['conflicts']: result['skipped'].append('nothing_to_remove')
    for key in ('planned_removals', 'preserved', 'skipped', 'conflicts'):
        result[key] = sorted(set(result[key]))
    return result


def _uninstall_path(item, launcher):
    if item == SERVICE: return UNITS / SERVICE
    if item == CACHE: return UNITS / CACHE
    if item == 'novel-tts': return launcher
    if item.startswith('app/') and item.removeprefix('app/') in OWNED_APP_FILES:
        return APP / item.removeprefix('app/')
    if item in (f'{SERVICE}.d/override.conf', f'{CACHE}.d/override.conf'): return UNITS / item
    raise ValueError(f'Alvo fora da allowlist: {item}')


def _validate_uninstall_target(item, path, launcher):
    """Revalidate type, containment and ownership immediately before moving."""
    if path.is_symlink() or not path.is_file():
        raise ValueError(f'Alvo administrativo mudou ou é inseguro: {item}')
    resolved = path.resolve(strict=True)
    if item.startswith('app/'):
        root = APP.resolve(strict=True)
        if resolved.parent != root:
            raise ValueError(f'Alvo fora da raiz da aplicação: {item}')
        _validate_manifest(APP / OWNERSHIP_FILE)
        return
    if item == 'novel-tts':
        if resolved != Path(os.path.abspath(launcher)) or not _owned_launcher(path):
            raise ValueError(f'Launcher mudou após o planejamento: {item}')
        return
    root = UNITS.resolve(strict=True)
    if not resolved.is_relative_to(root):
        raise ValueError(f'Alvo fora da raiz de units: {item}')
    if item in (SERVICE, CACHE):
        command = 'run' if item == SERVICE else 'cache'
        if not _owned_unit(path, command):
            raise ValueError(f'Unit mudou após o planejamento: {item}')
    elif not _owned_override(path):
        raise ValueError(f'Override mudou após o planejamento: {item}')


def _verify_uninstall(items, ctl):
    remaining = [item for item in items if _uninstall_path(item, Path.home() / '.local/bin/novel-tts').exists()]
    if remaining:
        raise ValueError('Verificação falhou: ' + ', '.join(remaining))
    for name in (SERVICE, CACHE):
        if name in items:
            if ctl('is-active', name, check=False).stdout.strip() == 'active':
                raise ValueError(f'Verificação falhou: {name} ainda ativo.')
            if ctl('is-enabled', name, check=False).stdout.strip() == 'enabled':
                raise ValueError(f'Verificação falhou: {name} ainda habilitado.')


def execute_uninstall(config, *, ctl, clock, mover=None, restore_mover=None, verifier=None):
    mover = shutil.move if mover is None else mover
    restore_mover = shutil.move if restore_mover is None else restore_mover
    verifier = (lambda items: _verify_uninstall(items, ctl)) if verifier is None else verifier
    plan = uninstall_plan()
    if plan['conflicts']:
        raise ValueError('Conflitos impedem uninstall: ' + ', '.join(plan['conflicts']))
    if not plan['planned_removals']:
        return plan
    configuration_schema(config)
    tx = InstallTransaction(config, ctl=ctl, ready=lambda _: None, source_dir=Path(__file__).resolve().parent, clock=clock)
    tx.snapshot(operation='uninstall')
    plan['snapshot_id'] = tx.backup.name
    quarantine = tx.backup / 'quarantine'; quarantine.mkdir(mode=0o700)
    moved = []
    try:
        managed_units = [name for name in (SERVICE, CACHE) if name in plan['planned_removals']]
        tx.mark(TransactionState.STOPPED)
        if managed_units:
            ctl('stop', *managed_units)
            ctl('disable', *managed_units)
        for item in plan['planned_removals']:
            path = _uninstall_path(item, tx.launcher)
            _validate_uninstall_target(item, path, tx.launcher)
            target = quarantine / item.replace('/', '__'); target.parent.mkdir(parents=True, exist_ok=True)
            mover(str(path), str(target)); moved.append(item)
        if APP.is_dir() and not any(APP.iterdir()): APP.rmdir()
        for name in (SERVICE, CACHE):
            dropdir = UNITS / f'{name}.d'
            if dropdir.is_dir() and not any(dropdir.iterdir()): dropdir.rmdir()
        if managed_units or any(item.endswith('.d/override.conf') for item in plan['planned_removals']):
            ctl('daemon-reload')
        verifier(plan['planned_removals'])
        plan['removed'] = moved
        tx.mark(TransactionState.COMMITTED)
        return plan
    except Exception as error:
        plan['rollback_performed'] = True
        rollback_errors = []
        try:
            tx.restore()
        except Exception as rollback_error:
            rollback_errors.append(rollback_error)
        for item in reversed(moved):
            saved = quarantine / item.replace('/', '__')
            destination = _uninstall_path(item, tx.launcher)
            if not saved.exists():
                continue
            try:
                destination.parent.mkdir(parents=True, exist_ok=True)
                if destination.is_symlink() or destination.is_file(): destination.unlink()
                restore_mover(str(saved), str(destination))
            except Exception as rollback_error:
                rollback_errors.append(rollback_error)
        plan['rollback_status'] = 'partial' if rollback_errors else 'complete'
        combined = None
        if rollback_errors:
            combined = RuntimeError('; '.join(str(item) for item in rollback_errors))
        failure = TransactionFailure(error, combined); failure.result = plan
        raise failure from error


def backup_root():
    return CONFIG_PATH.parent / 'backups'


def valid_backups():
    root = backup_root()
    if not root.is_dir():
        return []
    result = []
    for path in sorted(root.iterdir()):
        if not path.is_dir() or not (path / 'snapshot-ready').is_file() or not (path / 'states.json').is_file():
            continue
        try:
            states = json.loads((path / 'states.json').read_text())
            metadata = json.loads((path / 'snapshot.json').read_text()) if (path / 'snapshot.json').is_file() else {}
            if not all(name in states for name in (SERVICE, CACHE)):
                continue
        except (OSError, ValueError):
            continue
        result.append({'id': path.name, 'path': path, 'operation': metadata.get('operation', 'legacy'),
                       'schema': metadata.get('schema'), 'version': metadata.get('version')})
    return result


def validated_backup(snapshot_id):
    """Resolve one complete, local snapshot without accepting a filesystem path."""
    if not isinstance(snapshot_id, str) or not snapshot_id or Path(snapshot_id).name != snapshot_id or '/' in snapshot_id or '\\' in snapshot_id:
        raise ValueError('Identificador de backup inválido.')
    matches = [item for item in valid_backups() if item['id'] == snapshot_id]
    if len(matches) != 1:
        raise ValueError('Snapshot inválido, incompleto ou incompatível.')
    snapshot = matches[0]['path']
    if snapshot.is_symlink() or snapshot.resolve().parent != backup_root().resolve():
        raise ValueError('Snapshot fora do diretório de backups.')
    required = ('snapshot-ready', 'states.json', 'snapshot.json', 'config.json', 'app', SERVICE, CACHE, 'novel-tts')
    if any(not (snapshot / name).exists() or (snapshot / name).is_symlink() for name in required):
        raise ValueError('Snapshot incompleto ou contém links inseguros.')
    try:
        metadata = _snapshot_metadata(snapshot)
        states = json.loads((snapshot / 'states.json').read_text())
        config = json.loads((snapshot / 'config.json').read_text())
        _validated_states(states)
        if metadata.get('schema') != configuration_schema(config):
            raise ValueError('metadados incompatíveis')
        validate(config)
        _validate_ownership(snapshot)
    except (OSError, ValueError, TypeError, AttributeError, json.JSONDecodeError) as error:
        raise ValueError(f'Snapshot inválido ou incompatível: {error}') from error
    return snapshot, config


def _safe_reason(error):
    """A rejection reason for the terminal, with absolute paths masked."""
    return re.sub(r'(?:/[^\s:;,]+)+', '<caminho>', str(error))


def latest_validated_backup_id(skipped=None):
    """Newest setup/upgrade snapshot that passes the same validation as restore --backup-id.

    Snapshots made by restore (recovery), explicit backups, token rotation and
    uninstall are never candidates: they are not the state before the last
    installation change. Rejected candidates are appended to `skipped` as
    (id, reason) so the caller can tell the user instead of hiding them.
    """
    rejected = []
    for item in reversed(valid_backups()):
        if item['operation'] not in ROLLBACK_OPERATIONS:
            continue
        try:
            validated_backup(item['id'])
        except ValueError as error:
            rejected.append((item['id'], _safe_reason(error)))
            continue
        if skipped is not None:
            skipped.extend(rejected)
        return item['id']
    if skipped is not None:
        skipped.extend(rejected)
    detail = ''.join(f'\n  {name}: {reason}' for name, reason in rejected[:3])
    raise ValueError('Nenhum snapshot de setup ou upgrade validado para desfazer; liste com '
                     'novel-tts backups --json e restaure um deles com restore --backup-id.' + detail)


def transactional_restore(snapshot_id, current_config, *, ctl, ready, source_dir, clock):
    """Restore a selected snapshot and automatically recover the prior state."""
    snapshot, target_config = validated_backup(snapshot_id)
    transaction = InstallTransaction(current_config, ctl=ctl, ready=ready,
                                     source_dir=source_dir, clock=clock)
    transaction.plan()
    transaction.snapshot(operation='restore-recovery')
    try:
        transaction.config = target_config
        transaction.stage_restore(snapshot)
        transaction.swap()
        transaction.mark(TransactionState.COMMITTED)
        return transaction.backup
    except Exception as error:
        failure_stage = transaction.phase
        rollback_error = None
        rollback_status = 'not-started'
        if transaction.state in (TransactionState.STOPPED, TransactionState.SWAPPED, TransactionState.RELOADED, TransactionState.STARTED, TransactionState.READY):
            try:
                transaction.restore()
            except Exception as failure:
                rollback_error = failure
            rollback_status = 'partial' if rollback_error else 'complete'
        raise TransactionFailure(
            error, rollback_error, stage=failure_stage, rollback_status=rollback_status
        ) from error
    finally:
        if transaction.stage:
            shutil.rmtree(transaction.stage, ignore_errors=True)


def require_confirmation(yes, input_fn=input, interactive=None):
    if yes:
        return
    if interactive is None:
        interactive = sys.stdin.isatty()
    if not interactive:
        raise ValueError('Execução não interativa requer --yes.')
    if input_fn('Confirmar alteração? [s/N] ').strip().lower() not in ('s', 'sim', 'y', 'yes'):
        raise ValueError('Operação cancelada pelo usuário.')


def _run_cli_transaction(transaction, *, operation='setup'):
    """Attach safe phase metadata to failures before transaction rollback begins."""
    try:
        return transaction.run(operation=operation)
    except TransactionFailure:
        raise
    except Exception as error:
        raise TransactionFailure(error, stage=transaction.phase, rollback_status='not-needed') from error


def cli_failure_record(error):
    """Return a stable, redacted CLI error envelope for transaction/readiness failures."""
    if isinstance(error, TransactionFailure):
        detail = error.public_detail()
    elif isinstance(error, ReadinessFailure):
        detail = {
            'code': error.diagnostic_code,
            'stage': 'readiness',
            'rollback': 'not-started',
            'message': 'A verificação de prontidão falhou; detalhes sensíveis foram omitidos.',
        }
    else:
        detail = {
            'code': 'NLR_OPERATION_FAILED',
            'stage': 'unknown',
            'rollback': 'not-started',
            'message': 'A operação falhou; detalhes sensíveis foram omitidos.',
        }
    return {'ok': False, 'error': detail}


def cli_failure_output(error, *, json_output=False):
    """Serialize one safe failure document or one concise human diagnostic."""
    if json_output:
        return json.dumps(cli_failure_record(error), sort_keys=True)
    if isinstance(error, TransactionFailure):
        return f'Novel TTS: {error.safe_message()}'
    if isinstance(error, ReadinessFailure):
        return (
            'Novel TTS: falha de prontidão; '
            f'código {error.diagnostic_code}; detalhes sensíveis omitidos.'
        )
    return 'Novel TTS: operação falhou; detalhes sensíveis omitidos.'


def create_backup(config, *, ctl, clock=None, operation='backup'):
    clock = datetime.now if clock is None else clock
    transaction = InstallTransaction(config, ctl=ctl, ready=lambda _: None,
                                     source_dir=Path(__file__).resolve().parent, clock=clock)
    transaction.plan()
    transaction.snapshot(operation=operation)
    return transaction.backup


def rotate_token(*, ctl, clock=None):
    """Replace the pairing token after a snapshot; the cache unit reloads it."""
    config = validate(read_config())
    create_backup(config, ctl=ctl, clock=clock, operation='token-rotation')
    rotated = {**config, 'token': secrets.token_urlsafe(32)}
    atomic_json(CONFIG_PATH, rotated)
    try:
        ctl('try-restart', CACHE)
    except subprocess.CalledProcessError as error:
        raise ValueError(
            'Token gravado, mas o cache não reiniciou; o token antigo pode continuar aceito. '
            f'Execute systemctl --user restart {CACHE} e confira com novel-tts doctor.') from error
    return rotated['token']


def voice_payload(name, voice):
    return {
        'name': name,
        'ref_text': Path(voice['text']).read_text().rstrip('\n'),
        'spk_b64': base64.b64encode(Path(voice['spk']).read_bytes()).decode(),
        'rvq_b64': base64.b64encode(Path(voice['rvq']).read_bytes()).decode(),
    }


def register_voice(name, voice, endpoint):
    try:
        value = voice_payload(name, voice)
        if (not isinstance(name, str) or not name or not isinstance(value, dict) or
                set(value) != {'name', 'ref_text', 'spk_b64', 'rvq_b64'} or value.get('name') != name or
                not isinstance(value.get('ref_text'), str) or not value['ref_text'].strip() or
                not isinstance(value.get('spk_b64'), str) or not value['spk_b64'] or
                not isinstance(value.get('rvq_b64'), str) or not value['rvq_b64']):
            raise ValueError('invalid voice payload')
        if (not base64.b64decode(value['spk_b64'], validate=True) or
                not base64.b64decode(value['rvq_b64'], validate=True)):
            raise ValueError('empty voice assets')
        payload = json.dumps(value).encode('utf-8')
    except (OSError, UnicodeError, ValueError, TypeError) as error:
        raise ReadinessFailure(
            'NLR_VOICE_PAYLOAD_INVALID',
            'Os recursos locais da voz são inválidos ou indisponíveis.',
        ) from error
    request = urllib.request.Request(endpoint + '/v1/audio/voices', data=payload,
                                     headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status not in (200, 201):
            raise ReadinessFailure(
                'NLR_VOICE_REGISTRATION_REJECTED',
                f'O registro da voz foi recusado (HTTP {response.status}).',
            )
        return response.status


def register_when_ready(process, profile, timeout=180, *, listener_probe=None, voice_registrar=None,
                        opener=None, clock=None, sleeper=None):
    """Register only after owned Qwen health and voice-list endpoints respond."""
    endpoint = qwen_endpoint(profile)
    host = option(profile['argv'], '--host')
    port = int(option(profile['argv'], '--port'))
    probe = qwen_listener_status if listener_probe is None else listener_probe
    registrar = register_voice if voice_registrar is None else voice_registrar
    open_url = urllib.request.urlopen if opener is None else opener
    clock = time.monotonic if clock is None else clock
    sleeper = time.sleep if sleeper is None else sleeper
    deadline = clock() + max(0, timeout)
    attempt = 0
    health_ready = False

    for name, voice in profile.get('voices', {}).items():
        registration_confirmed = False
        registration_accepted = False
        last_code = 'NLR_QWEN_VOICE_API_UNAVAILABLE'
        last_message = 'API de vozes Qwen indisponível.'

        while clock() < deadline:
            ownership = _check_expected_qwen(process, host, port, probe)
            if ownership != 'owned':
                _retry_delay(deadline, attempt, clock, sleeper)
                attempt += 1
                continue

            if not health_ready:
                try:
                    with open_url(endpoint + '/health', timeout=_http_timeout(deadline, clock)) as response:
                        status = getattr(response, 'status', 200)
                    _check_expected_qwen(process, host, port, probe)
                    if status == 200:
                        health_ready = True
                    elif status == 404 or status >= 500:
                        last_code = 'NLR_QWEN_VOICE_API_UNAVAILABLE'
                        last_message = 'API de vozes Qwen indisponível.'
                    else:
                        _raise_permanent_qwen_status(status)
                except urllib.error.HTTPError as error:
                    status = error.code
                    error.close()
                    _check_expected_qwen(process, host, port, probe)
                    if status == 404 or status >= 500:
                        last_code = 'NLR_QWEN_VOICE_API_UNAVAILABLE'
                        last_message = 'API de vozes Qwen indisponível.'
                    else:
                        _raise_permanent_qwen_status(status)
                except ReadinessFailure:
                    raise
                except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
                    last_code = 'NLR_QWEN_VOICE_API_UNAVAILABLE'
                    last_message = 'API de vozes Qwen indisponível.'
                if not health_ready:
                    _retry_delay(deadline, attempt, clock, sleeper)
                    attempt += 1
                    continue

            # Health must be ready before the voice route is queried.
            try:
                _check_expected_qwen(process, host, port, probe)
                with open_url(endpoint + '/v1/audio/voices', timeout=_http_timeout(deadline, clock)) as response:
                    status = getattr(response, 'status', 200)
                    payload = json.load(response) if status == 200 else None
                _check_expected_qwen(process, host, port, probe)
                names = registered_voice_names(payload) if status == 200 else set()
            except urllib.error.HTTPError as error:
                status = error.code
                error.close()
                _check_expected_qwen(process, host, port, probe)
                if status in (404, 409) or status >= 500:
                    last_code = 'NLR_QWEN_VOICE_API_UNAVAILABLE'
                    last_message = 'API de vozes Qwen indisponível.'
                    _retry_delay(deadline, attempt, clock, sleeper)
                    attempt += 1
                    continue
                _raise_permanent_qwen_status(status)
            except ReadinessFailure:
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError,
                    ValueError, json.JSONDecodeError):
                last_code = 'NLR_QWEN_VOICE_API_UNAVAILABLE'
                last_message = 'API de vozes Qwen indisponível.'
                _retry_delay(deadline, attempt, clock, sleeper)
                attempt += 1
                continue

            if status in (404, 409) or status >= 500:
                last_code = 'NLR_QWEN_VOICE_API_UNAVAILABLE'
                last_message = 'API de vozes Qwen indisponível.'
                _retry_delay(deadline, attempt, clock, sleeper)
                attempt += 1
                continue
            if status != 200:
                _raise_permanent_qwen_status(status)
            if name in names:
                registration_confirmed = True
                break
            if registration_accepted:
                last_code = 'NLR_VOICE_NOT_CONFIRMED'
                last_message = 'A voz registrada ainda não foi confirmada pela API Qwen.'
                _retry_delay(deadline, attempt, clock, sleeper)
                attempt += 1
                continue

            # A missing exact name is the only condition that permits registration.
            _check_expected_qwen(process, host, port, probe)
            try:
                registrar(name, voice, endpoint)
                registration_accepted = True
                last_code = 'NLR_VOICE_NOT_CONFIRMED'
                last_message = 'A voz registrada ainda não foi confirmada pela API Qwen.'
            except urllib.error.HTTPError as error:
                status = error.code
                error.close()
                _check_expected_qwen(process, host, port, probe)
                if status == 409:
                    # A conflict may mean the API accepted an earlier concurrent registration.
                    # Query the list again; do not send duplicate POSTs while awaiting confirmation.
                    registration_accepted = True
                    last_code = 'NLR_VOICE_NOT_CONFIRMED'
                    last_message = 'A voz registrada ainda não foi confirmada pela API Qwen.'
                elif status == 404 or status >= 500:
                    last_code = 'NLR_QWEN_VOICE_API_UNAVAILABLE'
                    last_message = 'API de vozes Qwen indisponível.'
                else:
                    raise ReadinessFailure(
                        'NLR_VOICE_REGISTRATION_REJECTED',
                        f'Qwen recusou o registro da voz (HTTP {status}); detalhes omitidos.',
                    ) from None
            except ReadinessFailure:
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
                last_code = 'NLR_QWEN_VOICE_API_UNAVAILABLE'
                last_message = 'API de vozes Qwen indisponível.'
            _retry_delay(deadline, attempt, clock, sleeper)
            attempt += 1

        if not registration_confirmed:
            raise ReadinessFailure(last_code, last_message)


def qwen_online(profile, *, qwen_pids=None, listener_probe=None, opener=None, ctl=None):
    endpoint = qwen_endpoint(profile)
    host = option(profile['argv'], '--host')
    port = int(option(profile['argv'], '--port'))
    ctl = systemctl if ctl is None else ctl
    expected_pids = qwen_service_child_pids(ctl) if qwen_pids is None else qwen_pids
    probe = qwen_listener_status if listener_probe is None else listener_probe
    if probe(host, port, expected_pids) != 'owned':
        return False
    open_url = urllib.request.urlopen if opener is None else opener
    for path in ('/v1/audio/voices', '/v1/models', '/health'):
        try:
            if probe(host, port, expected_pids) != 'owned':
                return False
            with open_url(endpoint + path, timeout=2) as response:
                if response.status == 200 and probe(host, port, expected_pids) == 'owned':
                    return True
        except (OSError, ValueError):
            pass
    return False


def doctor_report(config, *, ctl, opener=None, qwen_pids=None, listener_probe=None):
    """Read-only health report with stable, actionable exit codes."""
    try:
        validate(config)
    except ValueError:
        return {'code': 1, 'healthy': False, 'message': 'Configuração inválida'}
    services = {name: ctl('is-active', name, check=False).stdout.strip() == 'active' for name in (SERVICE, CACHE)}
    profile = active_profile(config)
    upstream_port = int(option(profile['argv'], '--port'))
    report = {'services': services, 'upstream_port': upstream_port}
    if not all(services.values()):
        return {'code': 2, 'healthy': False, 'message': 'Units indisponíveis', **report}
    endpoint = qwen_endpoint(profile)
    host = option(profile['argv'], '--host')
    probe = qwen_listener_status if listener_probe is None else listener_probe
    expected_pids = qwen_service_child_pids(ctl) if qwen_pids is None else qwen_pids
    if probe(host, upstream_port, expected_pids) != 'owned':
        return {'code': 3, 'healthy': False, 'message': 'Backend TTS indisponível', **report}
    open_url = urllib.request.urlopen if opener is None else opener
    try:
        with open_url(endpoint + '/v1/audio/voices', timeout=2) as response:
            voices = registered_voice_names(json.load(response))
        if probe(host, upstream_port, expected_pids) != 'owned':
            return {'code': 3, 'healthy': False, 'message': 'Backend TTS indisponível', **report}
    except (OSError, ValueError, urllib.error.HTTPError, json.JSONDecodeError):
        return {'code': 3, 'healthy': False, 'message': 'Backend TTS indisponível', **report}
    if config['voice'] not in voices:
        return {'code': 4, 'healthy': False, 'message': 'Voz configurada não registrada', **report}
    headers = {'Authorization': 'Bearer ' + config['token']}
    try:
        with open_url(urllib.request.Request('http://127.0.0.1:8081/health', headers=headers), timeout=2) as response:
            health = json.load(response)
        with open_url(urllib.request.Request('http://127.0.0.1:8081/identity', headers=headers), timeout=2) as response:
            identity_data = json.load(response)
    except (OSError, ValueError, urllib.error.HTTPError, json.JSONDecodeError):
        return {'code': 5, 'healthy': False, 'message': 'Cache autenticado indisponível', **report}
    if health.get('version') != VERSION or health.get('mode') != config['mode'] or identity_data.get('mode') != config['mode']:
        return {'code': 6, 'healthy': False, 'message': 'Versão ou identidade incompatível', **report}
    return {'code': 0, 'healthy': True, 'message': 'Saudável', **report}


def launch(config):
    validate(config)
    profile = active_profile(config)
    ensure_qwen_port_available(profile)
    child = subprocess.Popen(profile['argv'], cwd=profile['cwd'], env=os.environ.copy())
    stopping = False

    def relay(signum, _frame):
        nonlocal stopping
        stopping = True
        if child.poll() is None:
            try:
                child.send_signal(signum)
            except ProcessLookupError:
                pass

    previous_handlers = {}
    for signum in (signal.SIGTERM, signal.SIGINT):
        previous_handlers[signum] = signal.signal(signum, relay)
    try:
        register_when_ready(child, profile, timeout=LAUNCH_READY_TIMEOUT)
        print('Qwen3-TTS pronto; vozes configuradas verificadas.', flush=True)
        code = child.wait()
        if code and not stopping:
            raise ValueError(f'O servidor Qwen3-TTS encerrou inesperadamente (código {code}).')
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


def main(argv=None, *, input_fn=input, interactive=None, ctl=None, ready=None):
    """CLI boundary. Planning is pure; execution dependencies are injectable."""
    ctl = systemctl if ctl is None else ctl
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan', 'setup', 'install', 'upgrade', 'backup', 'backups', 'restore', 'rollback', 'uninstall', 'run', 'cache', 'check', 'doctor', 'status', 'logs', 'token', 'config'])
    parser.add_argument('--json', dest='json_output', action='store_true', help='Saída JSON estável e redigida')
    parser.add_argument('--yes', action='store_true', help='Confirma alteração sem prompt')
    parser.add_argument('--dry-run', action='store_true', help='Mostra o plano sem alterar arquivos ou serviços')
    parser.add_argument('--backup-id', help='Identificador explícito do snapshot a restaurar')
    parser.add_argument('--data-root', help='Ponto de montagem opcional para o cache')
    parser.add_argument('--cache-dir', help='Diretório do cache (padrão: XDG_CACHE_HOME)')
    parser.add_argument('--cache-limit-mb', type=int, help='Limite do cache em MiB')
    mount_group = parser.add_mutually_exclusive_group()
    mount_group.add_argument('--require-mount', dest='require_mount', action='store_true', help='Exigir data_root montado')
    mount_group.add_argument('--no-require-mount', dest='require_mount', action='store_false', help='Permitir cache fora de ponto de montagem')
    parser.set_defaults(require_mount=None)
    parser.add_argument('--qwen-root', help='Pasta do qwentts.cpp já compilado')
    parser.add_argument('--server', help='Executável tts-server (padrão: <qwen-root>/build/tts-server)')
    parser.add_argument('--model', help='Talker Base GGUF')
    parser.add_argument('--codec', help='Tokenizer/codec GGUF')
    parser.add_argument('--language', default='English', help='Idioma encaminhado ao Qwen3-TTS')
    parser.add_argument('--qwen-port', default=8080, type=int, help='Porta loopback do Qwen3-TTS')
    parser.add_argument('--voice-name', help='Nome simples da voz registrada')
    parser.add_argument('--voice-spk', help='Embedding .spk pré-calculado')
    parser.add_argument('--voice-rvq', help='Códigos .rvq pré-calculados')
    parser.add_argument('--voice-text', help='Transcrição exata da referência')
    parser.add_argument('--rotate', action='store_true', help='Com token: gera um novo token e reinicia o cache')
    parser.add_argument('--ready-timeout', type=int, default=240,
                        help='Segundos aguardando Qwen, voz e cache depois de iniciar as units (30–1800)')
    args = parser.parse_args(argv)
    if not 30 <= args.ready_timeout <= 1800:
        raise ValueError('--ready-timeout precisa estar entre 30 e 1800 segundos.')
    if ready is None:
        ready = functools.partial(wait_ready, timeout=args.ready_timeout)

    def emit(value):
        if args.json_output:
            print(json.dumps(value, sort_keys=True))
        elif isinstance(value, dict):
            print('\n'.join(f'{key}: {value[key]}' for key in value))
        else:
            print(value)

    def supplied_config():
        return build_config(
            Path(args.data_root).resolve() if args.data_root else None,
            qwen_root=args.qwen_root, server=args.server, model=args.model, codec=args.codec,
            language=args.language, qwen_port=args.qwen_port, voice_name=args.voice_name,
            voice_spk=args.voice_spk, voice_rvq=args.voice_rvq, voice_text=args.voice_text,
            cache_dir=args.cache_dir, cache_limit_mb=args.cache_limit_mb,
            require_mount=args.require_mount, previous=existing_preferences(),
        )

    if args.command in ('plan', 'setup', 'install'):
        config = supplied_config()
        plan = install_plan(config, 'setup')
        if args.command == 'plan' or args.dry_run:
            emit(plan)
            return 0
        require_confirmation(args.yes, input_fn=input_fn, interactive=interactive)
        transaction = InstallTransaction(config, ctl=ctl, ready=ready,
                                         source_dir=Path(__file__).resolve().parent, clock=datetime.now)
        backup = _run_cli_transaction(transaction)
        emit({'operation': 'setup', 'backup_id': backup.name, 'backup': str(backup)})
        return 0
    if args.command == 'upgrade':
        config = read_config()
        schema = configuration_schema(config)
        migrated_from = None
        if schema == 2:
            config = migrate_schema_2_to_3(config)
            migrated_from = 2
        plan = upgrade_plan(config, migrated_from=migrated_from)
        if plan['idempotent'] or args.dry_run:
            emit(plan)
            return 0
        require_confirmation(args.yes, input_fn=input_fn, interactive=interactive)
        transaction = InstallTransaction(config, ctl=ctl, ready=ready,
                                         source_dir=Path(__file__).resolve().parent, clock=datetime.now)
        backup = _run_cli_transaction(transaction, operation='upgrade')
        emit({'operation': 'upgrade', 'backup_id': backup.name, 'schema': 3,
              **({'migration': {'from_schema': 2, 'to_schema': 3}} if migrated_from else {})})
        return 0
    if args.command == 'backup':
        config = read_config()
        backup = create_backup(config, ctl=ctl, operation='backup')
        emit({'operation': 'backup', 'backup_id': backup.name, 'backup': str(backup)})
        return 0
    if args.command == 'backups':
        values = [{key: value for key, value in item.items() if key != 'path'} for item in valid_backups()]
        emit(values if args.json_output else '\n'.join(item['id'] for item in values))
        return 0
    if args.command in ('restore', 'rollback'):
        if args.command == 'rollback':
            if args.backup_id:
                raise ValueError('rollback escolhe o snapshot validado mais recente; '
                                 'para escolher um ID use restore --backup-id.')
            skipped = []
            try:
                args.backup_id = latest_validated_backup_id(skipped)
            finally:
                for name, reason in skipped:
                    print(f'Novel TTS: snapshot {name} ignorado ({reason}).', file=sys.stderr)
        if not args.backup_id:
            raise ValueError('restore exige --backup-id explícito.')
        plan = restore_plan(args.backup_id)
        if args.dry_run:
            emit(plan)
            return 0
        print(f"Novel TTS: restaurando o snapshot {plan['backup_id']} ({plan['snapshot_operation']}, "
              f"criado em {plan['snapshot_created_at']}; aplicação {plan['snapshot_app_version']}).",
              file=sys.stderr)
        require_confirmation(args.yes, input_fn=input_fn, interactive=interactive)
        recovery = transactional_restore(args.backup_id, read_config(), ctl=ctl, ready=ready,
                                         source_dir=Path(__file__).resolve().parent, clock=datetime.now)
        emit({'operation': 'restore', 'backup_id': args.backup_id, 'recovery_backup_id': recovery.name})
        return 0
    if args.command == 'uninstall':
        plan = uninstall_plan()
        if args.dry_run:
            emit(plan); return 0
        if args.json_output and not args.yes:
            raise ValueError('uninstall --json efetivo requer --yes.')
        if not args.json_output:
            emit(plan)
        require_confirmation(args.yes, input_fn=input_fn, interactive=interactive)
        result = execute_uninstall(read_config(), ctl=ctl, clock=datetime.now)
        emit(result); return 0
    config = read_config()
    if args.command == 'token':
        if args.rotate:
            require_confirmation(args.yes, input_fn=input_fn, interactive=interactive)
            print(rotate_token(ctl=ctl))
            print('Token substituído: cole o novo valor nas opções da extensão.', file=sys.stderr)
        else:
            print(config['token'])
    elif args.command == 'config':
        print(CONFIG_PATH)
    elif args.command in ('doctor', 'status'):
        if args.command == 'doctor':
            report = doctor_report(config, ctl=ctl)
            if args.json_output:
                emit(report)
            else:
                print(f"Diagnóstico: {report['message']}")
                if 'upstream_port' in report:
                    print(f"Porta upstream configurada: {report['upstream_port']}")
                if 'services' in report:
                    for name, active in report['services'].items():
                        print(f"{name}: {'ativo' if active else 'inativo'}")
            return report['code']
        print(f"Backend: Qwen3-TTS\nVoz: {config['voice']}\nCache: {config['cache_dir']}")
        validate(config)
        profile = active_profile(config)
        endpoint = qwen_endpoint(profile).removeprefix('http://')
        print(f'Upstream {endpoint}: ' + ('online' if qwen_online(profile) else 'offline'))
        print(ctl('status', SERVICE, CACHE, '--no-pager', '--lines=0', check=False).stdout)
    elif args.command == 'logs':
        subprocess.run(['journalctl', '--user', '-u', SERVICE, '-u', CACHE, '-n', '80', '--no-pager'])
    elif args.command == 'check':
        validate(config)
    elif args.command == 'run':
        launch(config)
    elif args.command == 'cache':
        from companion_server import main as serve
        serve()
    return 0


def run_cli(argv=None):
    """Process boundary: map expected failures to one redacted line and status 1."""
    arguments = sys.argv[1:] if argv is None else list(argv)
    try:
        return main(arguments)
    except (TransactionFailure, ReadinessFailure) as error:
        print(cli_failure_output(error, json_output='--json' in arguments), file=sys.stderr)
    except FileNotFoundError as error:
        if error.filename and Path(error.filename) == CONFIG_PATH:
            print('Novel TTS: configuração não encontrada; execute ./install-service.sh primeiro.',
                  file=sys.stderr)
        else:
            print(f'Novel TTS: {error}', file=sys.stderr)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'Novel TTS: {error}', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(run_cli())
