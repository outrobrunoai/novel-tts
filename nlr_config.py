"""Configuration, validation, and cache identities for Novel TTS."""
import copy
import hashlib
import json
import os
import tempfile
from datetime import datetime
from pathlib import Path

APP_NAME = 'novel-local-reader'
CURRENT_SCHEMA = 3
CACHE_PORT = 8081
XDG_CONFIG_HOME = Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config')))
XDG_CACHE_HOME = Path(os.environ.get('XDG_CACHE_HOME', str(Path.home() / '.cache')))
XDG_DATA_HOME = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share')))
CONFIG_PATH = Path(os.environ.get('NLR_CONFIG_PATH', str(XDG_CONFIG_HOME / APP_NAME / 'config.json')))
DEFAULT_CACHE_DIR = XDG_CACHE_HOME / APP_NAME


def configuration_schema(config):
    """Return the supported schema number without normalizing or persisting."""
    if not isinstance(config, dict):
        raise ValueError('Configuração deve ser um objeto JSON.')
    schema = config.get('schema')
    if schema not in (2, CURRENT_SCHEMA) or config.get('backend') != 'qwen3' or config.get('mode') != 'qwen':
        raise ValueError('Configuração Qwen3-TTS inválida. Execute novel-tts install ou doctor.')
    return schema


def read_config(path=CONFIG_PATH):
    """Read schema 2 or 3 without migrating or writing any file."""
    data = json.loads(Path(path).read_text())
    configuration_schema(data)
    return data


def requires_mount(config):
    """Schema 2 keeps its historical mounted-data-root protection."""
    return config.get('require_mount', configuration_schema(config) == 2) is True


def migrate_schema_2_to_3(config):
    """Return a schema 3 copy; never writes the source configuration."""
    if configuration_schema(config) != 2:
        raise ValueError('A migração aceita apenas configurações schema 2.')
    migrated = copy.deepcopy(config)
    migrated['schema'] = CURRENT_SCHEMA
    # Schema 2 always enforced data_root as a mount. Retain that behavior.
    migrated['require_mount'] = True
    return migrated


def atomic_bytes(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.nlr-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def atomic_json(path, data):
    encoded = (json.dumps(data, indent=2, ensure_ascii=False) + '\n').encode()
    atomic_bytes(path, encoded)


def persist_migrated_config(path, migrated, backup_dir=None):
    """Back up an existing schema 2 file atomically, then atomically write schema 3."""
    path = Path(path)
    if configuration_schema(migrated) != CURRENT_SCHEMA:
        raise ValueError('A persistência exige uma configuração schema 3.')
    original = path.read_bytes()
    # Confirm the source is a valid schema 2 file before placing either output.
    if configuration_schema(json.loads(original)) != 2:
        raise ValueError('A configuração de origem não é schema 2.')
    directory = Path(backup_dir) if backup_dir else path.parent / 'backups'
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup = directory / f'config-schema-2-{stamp}.json'
    atomic_bytes(backup, original)
    atomic_json(path, migrated)
    return backup


def option(argv, name, default=None):
    try:
        return argv[argv.index(name) + 1]
    except (ValueError, IndexError):
        return default


def set_option(argv, name, value):
    argv = list(argv)
    if name in argv:
        i = argv.index(name)
        argv[i + 1] = str(value)
    else:
        argv.extend([name, str(value)])
    return argv


def active_profile(config):
    profile = config.get('profiles', {}).get(config.get('mode'))
    if not profile:
        raise ValueError('Perfil Qwen3-TTS não configurado.')
    return profile


def voice_names(config):
    return sorted(active_profile(config).get('voices', {}))


def resolve_voice(config, requested=''):
    """Resolve a registered name and transparently migrate old *.wav choices."""
    voices = active_profile(config).get('voices', {})
    name = requested or config.get('voice', '')
    if not isinstance(name, str) or not name or Path(name).name != name or name in ('.', '..'):
        raise ValueError('Selecione apenas o nome de uma voz registrada, sem caminho.')
    if name not in voices and name.lower().endswith('.wav'):
        legacy = name[:-4]
        if legacy in voices:
            name = legacy
    if name not in voices:
        raise ValueError(f'Voz não registrada: {name}')
    return name


_hashes = {}


def file_hash(path):
    path = Path(path).resolve(strict=True)
    stat = path.stat()
    stamp = (str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    if stamp not in _hashes:
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        _hashes[stamp] = digest.hexdigest()
    return _hashes[stamp]


def profile_assets(config, voice=''):
    profile = active_profile(config)
    argv = profile['argv']
    voice_name = resolve_voice(config, voice)
    voice_data = profile['voices'][voice_name]
    assets = [argv[0], option(argv, '--model'), option(argv, '--codec')]
    assets.extend(voice_data[key] for key in ('spk', 'rvq', 'text'))
    return voice_name, assets


def identity(config, voice=''):
    profile = active_profile(config)
    voice_name, assets = profile_assets(config, voice)
    data = {
        'schema': 3,
        'backend': 'qwen3',
        'mode': config['mode'],
        'voice': voice_name,
        'argv': profile['argv'],
        'assets': [file_hash(path) for path in assets],
    }
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def _existing_parent(path):
    parent = Path(path)
    while not parent.exists() and parent != parent.parent:
        parent = parent.parent
    return parent


def validate_cache_dir(value):
    """Check a cache path without creating it or writing a probe file."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError('cache_dir ausente ou inválido.')
    path = Path(value).expanduser().resolve(strict=False)
    dangerous = {
        Path('/').resolve(),
        Path.home().resolve(),
        XDG_CONFIG_HOME.resolve(),
        XDG_CACHE_HOME.resolve(),
        XDG_DATA_HOME.resolve(),
    }
    if path in dangerous:
        raise ValueError('cache_dir aponta para um diretório amplo ou perigoso.')
    if path.exists() and not path.is_dir():
        raise ValueError('cache_dir precisa ser um diretório.')
    parent = _existing_parent(path)
    if not parent.is_dir() or not os.access(parent, os.W_OK | os.X_OK):
        raise ValueError('cache_dir ou um diretório pai não é gravável.')
    return path


def validate_port(value, label):
    try:
        port = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f'Porta inválida para {label}.') from error
    if not 1024 <= port <= 65535:
        raise ValueError(f'Porta de {label} precisa estar entre 1024 e 65535.')
    return port


def validate(config, mode=None):
    _schema = configuration_schema(config)
    cache_dir = validate_cache_dir(config.get('cache_dir'))
    if requires_mount(config):
        root_value = config.get('data_root')
        if not isinstance(root_value, str) or not root_value:
            raise ValueError('data_root é obrigatório quando require_mount está ativo.')
        root = Path(root_value).expanduser().resolve(strict=False)
        if not root.is_mount():
            raise ValueError(f'HD não montado em {root}. Nada será criado nesse caminho.')
        if not cache_dir.is_relative_to(root.resolve()):
            raise ValueError('A pasta de cache precisa estar dentro do HD configurado.')
    limit = config.get('cache_limit_mb')
    if isinstance(limit, bool) or not isinstance(limit, int) or not 100 <= limit <= 50000:
        raise ValueError('cache_limit_mb precisa ser um inteiro entre 100 e 50000.')
    token = config.get('token')
    if not isinstance(token, str) or len(token) < 32:
        raise ValueError('Token local ausente ou inválido.')
    profile = config.get('profiles', {}).get(mode or config.get('mode'))
    if not profile:
        raise ValueError('Perfil Qwen3-TTS não disponível.')
    argv = profile.get('argv', [])
    if not argv or not os.access(argv[0], os.X_OK):
        raise ValueError(f"Executável ausente ou sem permissão: {argv[0] if argv else '<vazio>'}")
    if option(argv, '--host') not in ('127.0.0.1', 'localhost'):
        raise ValueError('O Qwen3-TTS precisa usar somente loopback.')
    qwen_port = validate_port(option(argv, '--port'), 'Qwen3-TTS')
    if qwen_port == CACHE_PORT:
        raise ValueError(f'A porta do Qwen3-TTS não pode ser a porta do cache ({CACHE_PORT}).')
    language = option(argv, '--lang')
    if not isinstance(language, str) or not language.strip():
        raise ValueError('Idioma do Qwen3-TTS ausente ou inválido.')
    for flag in ('--model', '--codec'):
        asset = option(argv, flag)
        if not asset or not Path(asset).is_file():
            raise ValueError(f'Modelo ausente para {flag}: {asset}')
    if not Path(profile.get('cwd', '')).is_dir():
        raise ValueError(f"Pasta do Qwen3-TTS ausente: {profile.get('cwd', '')}")
    voices = profile.get('voices', {})
    resolve_voice(config)
    for name, voice_data in voices.items():
        if not name or Path(name).name != name:
            raise ValueError(f'Nome de voz inválido: {name}')
        for key in ('spk', 'rvq', 'text'):
            asset = voice_data.get(key)
            if not asset or not Path(asset).is_file():
                raise ValueError(f'Arquivo {key} ausente para a voz {name}: {asset}')
    return config
