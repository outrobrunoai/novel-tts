#!/usr/bin/env python3
"""Build deterministic, allowlisted extension and host release artifacts."""
from __future__ import annotations
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile

VERSION_FILE = 'manifest.json'
ARTIFACT_PREFIX = 'novel-tts'
EXTENSION = (
    'manifest.json', 'background.js', 'content-runtime.js', 'content-playback.js', 'settings-schema.js', 'i18n.js', 'content-document.js', 'content-progress.js', 'content-navigation.js', 'content-panel.js', 'content.js', 'document-import.js', 'document-store.js',
    'library.js', 'options.js', 'page-theme.js', 'protocol.js', 'queue.js',
    'reader-bootstrap.js', 'reader.js', 'content.css', 'library.css', 'page-overlay.css', 'pages.css', 'reader.css',
    'themes.css', 'options.html', 'library.html', 'reader.html', 'icon.svg',
    'LICENSE', 'THIRD_PARTY_NOTICES.md', 'vendor/LICENSE.fflate', 'vendor/LICENSE.pdfjs',
    'vendor/fflate.mjs', 'vendor/pdf.mjs', 'vendor/pdf.worker.mjs',
)
HOST = ('novel_tts.py', 'nlr_config.py', 'companion_server.py', 'install-service.sh',
        'LICENSE', 'THIRD_PARTY_NOTICES.md', 'HOST_README.md', 'PRIVACY_POLICY.md')

def safe_name(name: str) -> str:
    path = PurePosixPath(name)
    if not name or name.startswith(('/', '\\')) or '\\' in name or '..' in path.parts or path.as_posix() != name:
        raise ValueError(f'unsafe allowlist path: {name}')
    return name

def tracked(root: Path) -> set[str]:
    try:
        result = subprocess.run(['git', 'ls-files', '-z'], cwd=root, check=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError) as error:
        raise RuntimeError('package_release.py exige um clone git do repositório; '
                           'o ZIP "Source code" do GitHub não contém .git.') from error
    return {item.decode() for item in result.stdout.split(b'\0') if item}

def sources(root: Path, names: tuple[str, ...]) -> list[tuple[str, Path]]:
    seen: set[str] = set(); git_files = tracked(root); result = []
    for name in names:
        safe_name(name)
        if name in seen: raise ValueError(f'duplicate allowlist path: {name}')
        seen.add(name)
        if name not in git_files: raise FileNotFoundError(f'allowlisted file is not tracked: {name}')
        path = root / name
        if path.is_symlink() or not path.is_file() or not stat.S_ISREG(path.stat().st_mode):
            raise ValueError(f'allowlisted file is not a regular non-symlink file: {name}')
        result.append((name, path))
    return sorted(result)

def read_regular(path: Path) -> bytes:
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError(f'not a regular file: {path.name}')
        chunks = []
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                return b''.join(chunks)
            chunks.append(chunk)
    finally:
        os.close(fd)


def write_zip(target: Path, files: list[tuple[str, Path]]) -> None:
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, path in files:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (0o100755 if name.endswith('.js') and False else 0o100644) << 16
            archive.writestr(info, read_regular(path))

def write_tar(target: Path, files: list[tuple[str, Path]], version: str) -> None:
    root_name = f'{ARTIFACT_PREFIX}-host-{version}'
    with target.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for name, path in files:
                info = tarfile.TarInfo(f'{root_name}/{name}')
                data = read_regular(path); info.size = len(data); info.uid = info.gid = 0
                info.uname = info.gname = ''; info.mtime = 0
                info.mode = 0o755 if name == 'install-service.sh' else 0o644
                archive.addfile(info, __import__('io').BytesIO(data))

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
    return digest.hexdigest()

def build(output: Path, root: Path) -> list[Path]:
    output = output.absolute()
    if output.exists() and (output.is_symlink() or not output.is_dir()):
        raise ValueError(f'unsafe output directory: {output}')
    if output.exists() and any(output.iterdir()):
        raise FileExistsError(f'output directory is not empty: {output}')
    manifest = json.loads((root / VERSION_FILE).read_text(encoding='utf-8'))
    version = manifest['version']
    extension_name = f'{ARTIFACT_PREFIX}-extension-{version}.zip'
    host_name = f'{ARTIFACT_PREFIX}-host-{version}.tar.gz'
    extension_files = sources(root, EXTENSION); host_files = sources(root, HOST)
    staging_name = tempfile.mkdtemp(prefix='.release-', dir=output.parent)
    staging = Path(staging_name)
    try:
        extension = staging / extension_name; host = staging / host_name
        write_zip(extension, extension_files); write_tar(host, host_files, version)
        public = {'schema': 1, 'project_version': version, 'protocol_version': 1,
                  'extension_signed': False, 'artifacts': []}
        for kind, path, files in (('extension', extension, extension_files), ('host', host, host_files)):
            public['artifacts'].append({'name': path.name, 'type': kind, 'size': path.stat().st_size,
                'sha256': sha256(path), 'files': [name for name, _ in files]})
        release_manifest = staging / 'release-manifest.json'
        release_manifest.write_text(json.dumps(public, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n', encoding='utf-8')
        sums = staging / 'SHA256SUMS'
        lines = [f'{sha256(path)}  {path.name}' for path in (extension, host, release_manifest)]
        sums.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        final = [output / path.name for path in (extension, host, release_manifest, sums)]
        # Publish the complete directory in one rename.  An interrupted build
        # therefore leaves either the old directory or no directory, never a
        # mixture of old and new artifacts.
        if output.exists():
            output.rmdir()
        os.replace(staging, output)
        return final
    except Exception:
        import shutil
        shutil.rmtree(staging, ignore_errors=True)
        raise

def main() -> int:
    parser = argparse.ArgumentParser(); parser.add_argument('--output', required=True)
    args = parser.parse_args(); root = Path(__file__).resolve().parents[1]
    try:
        build(Path(args.output), root)
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 2
    return 0

if __name__ == '__main__': raise SystemExit(main())
