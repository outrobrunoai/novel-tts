#!/usr/bin/env python3
import argparse
import json
import re
import tarfile
import zipfile
from pathlib import Path

def check(root, artifacts=None):
    manifest = root / 'manifest.json'
    try: version = json.loads(manifest.read_text())['version']
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        print('version consistency failed: manifest.json/version'); return 1
    if not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+', version):
        print('version consistency failed: manifest.json/version'); return 1
    checks = [
        ('novel_tts.py', rf"VERSION\s*=\s*['\"]{re.escape(version)}['\"]"),
        ('companion_server.py', rf"APP_VERSION\s*=\s*['\"]{re.escape(version)}['\"]"),
        ('protocol.js', rf'APP_VERSION\s*=\s*["\']{re.escape(version)}["\']'),
        ('content-panel.js', rf'<span class="nlr-version">{re.escape(version)}</span>'),
        ('content.js', rf"version:\s*['\"]{re.escape(version)}['\"]"),
        ('README.md', rf'(?<![0-9A-Za-z]){re.escape(version)}(?![0-9A-Za-z])'),
        ('docs/GUIDE.md', rf'(?<![0-9A-Za-z]){re.escape(version)}(?![0-9A-Za-z])'),
        ('TESTING.md', rf'(?<![0-9A-Za-z]){re.escape(version)}(?![0-9A-Za-z])'),
        ('RELEASE_NOTES.md', rf'(?<![0-9A-Za-z]){re.escape(version)}(?![0-9A-Za-z])'),
    ]
    bad = []
    for name, pattern in checks:
        try: ok = re.search(pattern, (root / name).read_text()) is not None
        except OSError: ok = False
        if not ok: bad.append(name)
    if bad: print('version consistency failed: ' + ', '.join(bad)); return 1
    if artifacts is not None:
        try:
            directory = Path(artifacts)
            metadata = json.loads((directory / 'release-manifest.json').read_text(encoding='utf-8'))
            if metadata.get('project_version') != version:
                raise ValueError('release-manifest project_version')
            # Names come from the manifest so a renamed artifact prefix needs no edit here.
            names = {item.get('type'): item.get('name') for item in metadata.get('artifacts', [])}
            extension_name, host_name = names['extension'], names['host']
            with zipfile.ZipFile(directory / extension_name) as archive:
                extension_manifest = json.loads(archive.read('manifest.json'))
                protocol = archive.read('protocol.js').decode('utf-8')
                panel = archive.read('content-panel.js').decode('utf-8')
                content = archive.read('content.js').decode('utf-8')
            if (extension_manifest.get('version') != version or
                    not re.search(rf'APP_VERSION\s*=\s*["\']{re.escape(version)}["\']', protocol) or
                    f'<span class="nlr-version">{version}</span>' not in panel or
                    not re.search(rf"version:\s*['\"]{re.escape(version)}['\"]", content)):
                raise ValueError('extension artifact component versions')
            with tarfile.open(directory / host_name, 'r:gz') as archive:
                root_name = host_name.removesuffix('.tar.gz')
                host_manager = archive.extractfile(f'{root_name}/novel_tts.py').read().decode('utf-8')
                host_service = archive.extractfile(f'{root_name}/companion_server.py').read().decode('utf-8')
            if (not re.search(rf"VERSION\s*=\s*['\"]{re.escape(version)}['\"]", host_manager) or
                    not re.search(rf"APP_VERSION\s*=\s*['\"]{re.escape(version)}['\"]", host_service)):
                raise ValueError('host artifact component versions')
        except (OSError, ValueError, KeyError, TypeError, AttributeError,
                zipfile.BadZipFile, tarfile.TarError):
            print('version consistency failed: release artifacts')
            return 1
    print(f'version consistency: OK ({version})' +
          (' including release artifacts' if artifacts is not None else ''))
    return 0

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', type=Path)
    args = parser.parse_args()
    raise SystemExit(check(Path(__file__).resolve().parents[1], args.artifacts))
