#!/usr/bin/env python3
"""Validate built release archives, allowlists, references, and public metadata."""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import zipfile

import package_release as packages

REQUIRED_EXTENSION = {
    'settings-schema.js', 'i18n.js', 'content-document.js', 'content-progress.js',
    'content-navigation.js', 'content-panel.js', 'page-overlay.css',
    'vendor/pdf.mjs', 'vendor/pdf.worker.mjs',
    'vendor/LICENSE.pdfjs', 'vendor/LICENSE.fflate',
}
FORBIDDEN_SUFFIXES = {'.gguf', '.spk', '.rvq', '.wav', '.mp3', '.flac', '.ogg'}
PRIVATE_MARKERS = ('BEGIN PRIVATE KEY',)
PRIVATE_PATH = re.compile(rb'(?i)/(?:home|mnt)/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*')
HTML_REFERENCE = re.compile(r'\b(?:src|href)=[\"\']([^\"\']+)[\"\']', re.IGNORECASE)
JS_FILE_REFERENCE = re.compile(r'[\"\']([A-Za-z0-9_.-]+\.js)[\"\']')
JS_IMPORT_REFERENCE = re.compile(r'\b(?:from\s*|import\s*\()\s*[\"\']([^\"\']+)[\"\']')
CSS_REFERENCE = re.compile(r'url\(\s*[\"\']?([^\"\')]+)[\"\']?\s*\)', re.IGNORECASE)


def _fail(reason: str) -> None:
    raise ValueError(reason)


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _verify_release_metadata(directory: Path, version: str) -> dict:
    metadata_path = directory / 'release-manifest.json'
    sums_path = directory / 'SHA256SUMS'
    try:
        metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        _fail('release-manifest.json ausente ou inválido')
    if metadata.get('schema') != 1 or metadata.get('project_version') != version:
        _fail('versão/schema do manifesto de release inválido')
    expected_names = {
        f'{packages.ARTIFACT_PREFIX}-extension-{version}.zip',
        f'{packages.ARTIFACT_PREFIX}-host-{version}.tar.gz',
    }
    expected_directory_entries = expected_names | {'release-manifest.json', 'SHA256SUMS'}
    if {path.name for path in directory.iterdir()} != expected_directory_entries:
        _fail('diretório de artefatos contém arquivo extra ou ausente')
    artifacts = metadata.get('artifacts')
    if not isinstance(artifacts, list) or {item.get('name') for item in artifacts} != expected_names:
        _fail('inventário de artefatos do manifesto inválido')
    if {item.get('type') for item in artifacts} != {'extension', 'host'} or len(artifacts) != 2:
        _fail('tipos de artefato duplicados ou inválidos')
    expected_sum_lines = []
    for item in artifacts:
        path = directory / item['name']
        if not path.is_file() or path.stat().st_size != item.get('size') or _digest(path) != item.get('sha256'):
            _fail('tamanho/hash de artefato não corresponde ao manifesto')
        expected_sum_lines.append(f"{_digest(path)}  {path.name}")
    expected_sum_lines.append(f"{_digest(metadata_path)}  release-manifest.json")
    if sums_path.read_text(encoding='utf-8').splitlines() != expected_sum_lines:
        _fail('SHA256SUMS inválido')
    return {item['type']: item for item in artifacts}


def _safe_public_archive(names: set[str], contents: dict[str, bytes]) -> None:
    for name in names:
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or path.as_posix() != name:
            _fail('artefato contém caminho inválido')
        if path.suffix.lower() in FORBIDDEN_SUFFIXES:
            _fail('artefato contém classe de arquivo pessoal/modelo proibida')
    for name, data in contents.items():
        text = data.decode('utf-8', errors='ignore').lower()
        if any(marker.lower() in text for marker in PRIVATE_MARKERS):
            _fail('artefato contém marcador de dado pessoal/proibido')
        for match in PRIVATE_PATH.findall(data):
            # Only the known PDF.js worker bundle embeds its generic build root.
            if name == 'vendor/pdf.worker.mjs' and match.lower() == b'/home/web_user':
                continue
            _fail('artefato contém caminho privado absoluto')
        if re.search(rb'(?im)authorization\s*:\s*bearer\s+[A-Za-z0-9._~-]{20,}', data):
            _fail('artefato contém credencial embutida')


def _verify_extension(archive_path: Path, manifest_item: dict, version: str) -> None:
    try:
        with zipfile.ZipFile(archive_path) as archive:
            names_list = archive.namelist()
            contents = {name: archive.read(name) for name in names_list}
    except (OSError, zipfile.BadZipFile):
        _fail('ZIP da extensão inválido')
    names = set(names_list)
    if len(names_list) != len(names) or names_list != sorted(names_list):
        _fail('membros do ZIP não são únicos e ordenados')
    expected = set(packages.EXTENSION)
    if names != expected or names != set(manifest_item.get('files', [])):
        _fail('membros do ZIP diferem da allowlist/manifesto')
    if not REQUIRED_EXTENSION <= names:
        _fail('módulos, CSS, vendor ou licenças obrigatórios ausentes')
    _safe_public_archive(names, contents)

    extension_manifest = json.loads(contents['manifest.json'])
    if extension_manifest.get('version') != version:
        _fail('versão do manifest da extensão diverge')
    gecko = extension_manifest.get('browser_specific_settings', {}).get('gecko', {})
    data_permissions = gecko.get('data_collection_permissions', {})
    if (float(gecko.get('strict_min_version', '0')) < 140 or
            data_permissions != {'required': ['authenticationInfo', 'websiteContent']}):
        _fail('declaração de dados/compatibilidade Firefox não corresponde ao fluxo declarado')
    protocol = contents['protocol.js'].decode('utf-8')
    panel = contents['content-panel.js'].decode('utf-8')
    content = contents['content.js'].decode('utf-8')
    if (not re.search(rf'APP_VERSION\s*=\s*["\']{re.escape(version)}["\']', protocol) or
            f'<span class="nlr-version">{version}</span>' not in panel or
            not re.search(rf"version:\s*['\"]{re.escape(version)}['\"]", content)):
        _fail('versão de protocolo/apresentação da extensão diverge do artefato')
    referenced = set(extension_manifest.get('background', {}).get('scripts', []))
    referenced.update(extension_manifest.get('icons', {}).values())
    referenced.add(extension_manifest.get('options_ui', {}).get('page', ''))
    for item in extension_manifest.get('web_accessible_resources', []):
        referenced.update(item.get('resources', []))
    if not referenced <= names:
        _fail('manifest.json referencia arquivo ausente no ZIP')

    for html_name in (name for name in names if name.endswith('.html')):
        html = contents[html_name].decode('utf-8')
        for reference in HTML_REFERENCE.findall(html):
            if reference.startswith(('http:', 'https:', 'data:', '#')):
                continue
            relative = (PurePosixPath(html_name).parent / reference.split('#', 1)[0]).as_posix()
            if relative not in names:
                _fail('página HTML referencia arquivo ausente no ZIP')

    for source_name in ('background.js', 'content.js'):
        source = contents[source_name].decode('utf-8')
        for reference in JS_FILE_REFERENCE.findall(source):
            if reference not in names:
                _fail('injeção/registro JavaScript referencia arquivo ausente no ZIP')
    for source_name in (name for name in names if name.endswith('.js')):
        source = contents[source_name].decode('utf-8')
        for reference in JS_IMPORT_REFERENCE.findall(source):
            if reference.startswith(('.', '/')):
                relative = (PurePosixPath(source_name).parent / reference).as_posix()
                if relative not in names:
                    _fail('módulo JavaScript referencia arquivo ausente no ZIP')
    for source_name in (name for name in names if name.endswith('.css')):
        source = contents[source_name].decode('utf-8')
        for reference in CSS_REFERENCE.findall(source):
            if reference.startswith(('data:', 'http:', 'https:')):
                continue
            relative = (PurePosixPath(source_name).parent / reference.split('#', 1)[0]).as_posix()
            if relative not in names:
                _fail('CSS referencia arquivo ausente no ZIP')
    background = contents['background.js'].decode('utf-8')
    ordered_scripts = ['protocol.js', 'content-runtime.js', 'content-playback.js',
                       'settings-schema.js', 'i18n.js', 'content-document.js', 'content-progress.js',
                       'content-navigation.js', 'content-panel.js', 'content.js']
    expected_dynamic = "js: [" + ','.join(repr(name) for name in ordered_scripts)
    execute_files = "files:[" + ','.join(repr(name) for name in ordered_scripts)
    if expected_dynamic not in background or execute_files not in background:
        _fail('ordem ou lista de injeção dinâmica incompleta')


def _verify_host(archive_path: Path, manifest_item: dict, version: str) -> None:
    try:
        with tarfile.open(archive_path, 'r:gz') as archive:
            members = archive.getmembers()
            contents = {member.name: archive.extractfile(member).read()
                        for member in members if member.isfile()}
    except (OSError, tarfile.TarError):
        _fail('tar.gz do host inválido')
    root = f'{packages.ARTIFACT_PREFIX}-host-{version}'
    names = {name.removeprefix(root + '/') for name in contents}
    if any(not name.startswith(root + '/') for name in contents):
        _fail('tar.gz do host contém caminho fora da raiz esperada')
    if names != set(packages.HOST) or names != set(manifest_item.get('files', [])):
        _fail('membros do tar.gz diferem da allowlist/manifesto')
    if any(not member.isfile() for member in members):
        _fail('tar.gz contém membro não regular')
    if not {'novel_tts.py', 'nlr_config.py', 'companion_server.py',
            'install-service.sh', 'HOST_README.md', 'PRIVACY_POLICY.md'} <= names:
        _fail('scripts/documentação obrigatórios ausentes do host')
    _safe_public_archive(names, {name: data for name, data in contents.items()})

    product_files = {
        name: contents[f'{root}/{name}'].decode('utf-8')
        for name in ('novel_tts.py', 'companion_server.py')
    }
    if (not re.search(rf"VERSION\s*=\s*['\"]{re.escape(version)}['\"]", product_files['novel_tts.py']) or
            not re.search(rf"APP_VERSION\s*=\s*['\"]{re.escape(version)}['\"]", product_files['companion_server.py'])):
        _fail('versão do host difere dos metadados do artefato')

    modules = set()
    for name in ('novel_tts.py', 'nlr_config.py', 'companion_server.py'):
        tree = ast.parse(contents[f'{root}/{name}'].decode('utf-8'), filename=name)
        modules.update(node.module.split('.')[0] for node in ast.walk(tree)
                       if isinstance(node, ast.ImportFrom) and node.module)
        modules.update(alias.name.split('.')[0] for node in ast.walk(tree)
                       if isinstance(node, ast.Import) for alias in node.names)
    local_modules = {PurePosixPath(name).stem for name in names if name.endswith('.py')}
    if not {'novel_tts', 'nlr_config', 'companion_server'} <= local_modules:
        _fail('host possui referência interna Python ausente')
    if not {'nlr_config', 'companion_server'} <= modules:
        _fail('host não importa seus módulos locais esperados')
    installer = contents[f'{root}/install-service.sh'].decode('utf-8')
    host_readme = contents[f'{root}/HOST_README.md'].decode('utf-8').lower()
    privacy_policy = contents[f'{root}/PRIVACY_POLICY.md'].decode('utf-8')
    if 'novel_tts.py' not in installer or 'consulte o readme principal' in host_readme:
        _fail('HOST_README não é autossuficiente ou launcher inválido')
    if not all(term in host_readme for term in ('install-service.sh', 'upgrade', 'restore', 'snapshot', 'privacy_policy.md')):
        _fail('HOST_README omite fluxo operacional necessário')
    # The package installs an engine that has no authentication and allows any origin.
    if 'cors' not in host_readme:
        _fail('HOST_README omite a limitação do motor sem autenticação (CORS)')
    if not all(term in privacy_policy for term in
               ('authenticationInfo', 'websiteContent', 'temperature', 'seed',
                '127.0.0.1:8081', 'Authorization', 'configured', 'cach')):
        _fail('política de privacidade não cobre os dados/destinos observados')
    if 'CORS' not in privacy_policy:
        _fail('política de privacidade omite a limitação do motor sem autenticação (CORS)')


def inspect(directory: Path) -> None:
    directory = Path(directory)
    try:
        version = json.loads((Path(__file__).resolve().parents[1] / 'manifest.json').read_text())['version']
    except (OSError, KeyError, json.JSONDecodeError):
        _fail('versão do projeto indisponível')
    artifacts = _verify_release_metadata(directory, version)
    _verify_extension(directory / artifacts['extension']['name'], artifacts['extension'], version)
    _verify_host(directory / artifacts['host']['name'], artifacts['host'], version)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    args = parser.parse_args()
    inspect(args.directory)
    print('release artifacts: OK (allowlists, references, integrity, privacy)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
