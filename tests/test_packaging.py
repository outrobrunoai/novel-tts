import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
import tarfile
import hashlib
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location('package_release', ROOT / 'scripts/package_release.py')
PACKAGE = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(PACKAGE)
INSPECTOR_SPEC = importlib.util.spec_from_file_location('inspect_release', ROOT / 'scripts/inspect_release.py')
RELEASE_INSPECTOR = importlib.util.module_from_spec(INSPECTOR_SPEC)
INSPECTOR_SPEC.loader.exec_module(RELEASE_INSPECTOR)
VERSION_CHECKER_SPEC = importlib.util.spec_from_file_location('check_versions', ROOT / 'scripts/check_versions.py')
VERSION_CHECKER = importlib.util.module_from_spec(VERSION_CHECKER_SPEC)
VERSION_CHECKER_SPEC.loader.exec_module(VERSION_CHECKER)
VERSION = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))['version']


def inside_git_checkout():
    try:
        return subprocess.run(['git', 'rev-parse', '--is-inside-work-tree'], cwd=ROOT,
                              capture_output=True, text=True, check=False).stdout.strip() == 'true'
    except OSError:
        return False


needs_git = unittest.skipUnless(inside_git_checkout(), 'o empacotamento exige um clone git')


class PackagingTests(unittest.TestCase):
    def build(self, parent): return PACKAGE.build(Path(parent) / 'out', ROOT)

    @needs_git
    def test_artifacts_use_the_public_prefix_and_are_discoverable(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / 'out'
            PACKAGE.build(out, ROOT)
            self.assertEqual(PACKAGE.ARTIFACT_PREFIX, 'novel-tts')
            names = {path.name for path in out.iterdir()}
            self.assertIn(f'novel-tts-extension-{VERSION}.zip', names)
            self.assertIn(f'novel-tts-host-{VERSION}.tar.gz', names)
            for kind, expected in (('extension', f'novel-tts-extension-{VERSION}.zip'),
                                   ('host', f'novel-tts-host-{VERSION}.tar.gz')):
                result = subprocess.run([sys.executable, str(ROOT / 'scripts/release_asset.py'), kind, str(out)],
                                        capture_output=True, text=True, check=True)
                self.assertEqual(result.stdout.strip(), expected)

    def test_source_archive_without_git_fails_with_guidance(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, 'clone git'):
                PACKAGE.tracked(Path(temp))

    def test_visual_preview_harness_is_not_shipped(self):
        self.assertFalse({'preview.html', 'preview.js'} & set(PACKAGE.EXTENSION))

    @needs_git
    def test_double_build_is_byte_identical_and_manifest_has_no_private_data(self):
        with tempfile.TemporaryDirectory() as temp:
            first = Path(temp) / 'a'; second = Path(temp) / 'b'; first.mkdir(); second.mkdir()
            PACKAGE.build(first, ROOT); PACKAGE.build(second, ROOT)
            for name in (f'{PACKAGE.ARTIFACT_PREFIX}-extension-{VERSION}.zip', f'{PACKAGE.ARTIFACT_PREFIX}-host-{VERSION}.tar.gz', 'release-manifest.json','SHA256SUMS'):
                self.assertEqual((first / name).read_bytes(), (second / name).read_bytes(), name)
            data = json.loads((first / 'release-manifest.json').read_text())
            serialized = json.dumps(data)
            self.assertNotRegex(serialized, r'(/home/|/mnt/|token|hostname|202[0-9]-)')
            self.assertNotIn('release-manifest.json', [a['name'] for a in data['artifacts']])

    @needs_git
    def test_version_checker_validates_components_inside_release_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'release'
            output.mkdir()
            PACKAGE.build(output, ROOT)
            self.assertEqual(VERSION_CHECKER.check(ROOT, output), 0)
            extension = output / f'{PACKAGE.ARTIFACT_PREFIX}-extension-{VERSION}.zip'
            replacement = output / 'modified.zip'
            with zipfile.ZipFile(extension) as source, zipfile.ZipFile(replacement, 'w') as target:
                for name in source.namelist():
                    data = source.read(name)
                    if name == 'content-panel.js':
                        data = data.replace(f'<span class="nlr-version">{VERSION}</span>'.encode(),
                                            b'<span class="nlr-version">9.9.9</span>')
                    target.writestr(name, data)
            replacement.replace(extension)
            self.assertEqual(VERSION_CHECKER.check(ROOT, output), 1)

    @needs_git
    def test_archive_members_are_sorted_regular_and_allowlisted(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp); PACKAGE.build(out, ROOT)
            with zipfile.ZipFile(out / f'{PACKAGE.ARTIFACT_PREFIX}-extension-{VERSION}.zip') as archive:
                names = archive.namelist(); self.assertEqual(names, sorted(names)); self.assertEqual(len(names), len(set(names)))
                self.assertIn('manifest.json', names); self.assertFalse(any(name.endswith(('.py','.sh','.cjs')) for name in names))
                manifest = json.loads(archive.read('manifest.json'))
                self.assertEqual(manifest['browser_specific_settings']['gecko']['data_collection_permissions'],
                    {'required':['authenticationInfo','websiteContent']})
                self.assertIn('content-panel.js', names)
                self.assertIn('i18n.js', names)
                self.assertIn('settings-schema.js', names)
                self.assertIn('reader-bootstrap.js', names)
                self.assertIn('page-overlay.css', names)
                packaged_reader = archive.read('reader.html').decode('utf-8')
                self.assertRegex(packaged_reader, r'<link\s+rel="stylesheet"\s+href="page-overlay\.css"')
                self.assertIn(b'.nlr-reading-paragraph', archive.read('page-overlay.css'))
                self.assertTrue(all(not Path(name).is_absolute() and '..' not in Path(name).parts for name in names))
            reader = (ROOT / 'reader.html').read_text()
            self.assertLess(reader.index('reader-bootstrap.js'), reader.index('id="reader-module"'))
            self.assertLess(reader.index('document-import.js'), reader.index('id="reader-module"'))
            self.assertLess(reader.index('content-navigation.js'), reader.index('content-panel.js'))
            self.assertLess(reader.index('content-panel.js'), reader.index('content.js'))
            self.assertLess(reader.index('i18n.js'), reader.index('content-panel.js'))
            with tarfile.open(out / f'{PACKAGE.ARTIFACT_PREFIX}-host-{VERSION}.tar.gz') as archive:
                members = archive.getmembers(); self.assertTrue(all(m.isreg() for m in members))
                self.assertTrue(all(m.uid == 0 and m.gid == 0 and m.mtime == 0 for m in members))
                self.assertEqual(members[0].name.split('/')[0], f'{PACKAGE.ARTIFACT_PREFIX}-host-{VERSION}')

    def test_unsafe_allowlist_names_and_nonempty_output_are_rejected(self):
        for name in ('../secret', '/absolute', r'bad\\name'):
            with self.assertRaises(ValueError): PACKAGE.safe_name(name)
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp); (output / 'existing').write_text('x')
            with self.assertRaises(FileExistsError): PACKAGE.build(output, ROOT)

    @needs_git
    def test_independent_hashes_and_sha_format(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp); PACKAGE.build(out, ROOT)
            sums = (out / 'SHA256SUMS').read_text().splitlines()
            self.assertEqual([line.split('  ')[1] for line in sums], [
                f'{PACKAGE.ARTIFACT_PREFIX}-extension-{VERSION}.zip',
                f'{PACKAGE.ARTIFACT_PREFIX}-host-{VERSION}.tar.gz', 'release-manifest.json'])
            for line in sums:
                digest, name = line.split('  ')
                self.assertEqual(digest, hashlib.sha256((out / name).read_bytes()).hexdigest())
                self.assertNotIn('/', name); self.assertNotIn('..', name)

    @needs_git
    def test_tar_permissions_and_zip_metadata_are_independently_normalized(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp); PACKAGE.build(out, ROOT)
            with zipfile.ZipFile(out / f'{PACKAGE.ARTIFACT_PREFIX}-extension-{VERSION}.zip') as archive:
                for info in archive.infolist():
                    self.assertEqual(info.date_time, (1980, 1, 1, 0, 0, 0))
                    self.assertEqual(info.create_system, 3)
                    self.assertEqual(info.external_attr >> 16, 0o100644)
                    self.assertEqual(archive.read(info.filename), archive.open(info.filename).read())
            with tarfile.open(out / f'{PACKAGE.ARTIFACT_PREFIX}-host-{VERSION}.tar.gz') as archive:
                members = archive.getmembers()
                self.assertEqual({m.name.split('/', 1)[0] for m in members}, {f'{PACKAGE.ARTIFACT_PREFIX}-host-{VERSION}'})
                for member in members:
                    self.assertEqual(member.uname, ''); self.assertEqual(member.gname, '')
                    expected = 0o755 if member.name.endswith('/install-service.sh') else 0o644
                    self.assertEqual(member.mode, expected)
                    self.assertEqual(archive.extractfile(member).read(), archive.extractfile(member).read())

    @needs_git
    def test_release_inspector_accepts_actual_archives_and_checks_host_readme(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / 'release'; out.mkdir()
            PACKAGE.build(out, ROOT)
            result = subprocess.run(
                [sys.executable, str(ROOT / 'scripts/inspect_release.py'), '--directory', str(out)],
                cwd=ROOT, check=False, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            self.assertIn('release artifacts: OK', result.stdout)
            with zipfile.ZipFile(out / f'{PACKAGE.ARTIFACT_PREFIX}-extension-{VERSION}.zip') as archive:
                panel = archive.read('content-panel.js').decode('utf-8')
                self.assertIn('Alice=voice-alice', panel)
                self.assertIn('Bob=voice-bob', panel)
            with tarfile.open(out / f'{PACKAGE.ARTIFACT_PREFIX}-host-{VERSION}.tar.gz') as archive:
                readme = archive.extractfile(f'{PACKAGE.ARTIFACT_PREFIX}-host-{VERSION}/HOST_README.md').read().decode()
                privacy = archive.extractfile(f'{PACKAGE.ARTIFACT_PREFIX}-host-{VERSION}/PRIVACY_POLICY.md').read().decode()
                self.assertNotIn('README principal', readme)
                self.assertIn('upgrade', readme)
                self.assertIn('restore', readme)
                self.assertIn('authenticationInfo', privacy)
                self.assertIn('websiteContent', privacy)
                self.assertIn('temperature', privacy)
                self.assertIn('seed', privacy)
                self.assertIn('metrics', privacy)
                self.assertIn('technicalAndInteraction', privacy)
                self.assertIn('loopback', privacy)
                self.assertIn('Novel TTS', privacy)
                self.assertNotIn('AMO reviewer', privacy)

    def test_release_inspector_rejects_private_paths_but_allows_vendor_build_root(self):
        RELEASE_INSPECTOR._safe_public_archive(
            {'vendor/pdf.worker.mjs'},
            {'vendor/pdf.worker.mjs': b'known PDF.js build root /home/web_user'},
        )
        with self.assertRaisesRegex(ValueError, 'caminho privado'):
            RELEASE_INSPECTOR._safe_public_archive(
                {'sample.js'}, {'sample.js': b'/' + b'home/' + b'example-user/' + b'private-file'}
            )

    @needs_git
    def test_publication_failure_leaves_no_partial_output(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / 'out'; out.mkdir()
            original = os.replace
            def fail_replace(source, destination):
                if Path(destination) == out:
                    raise OSError('injected publication failure')
                return original(source, destination)
            PACKAGE.os.replace = fail_replace
            try:
                with self.assertRaises(OSError): PACKAGE.build(out, ROOT)
            finally:
                PACKAGE.os.replace = original
            self.assertFalse(out.exists() and list(out.iterdir()))
            self.assertFalse(any(p.name.startswith('.release-') for p in out.parent.iterdir()))

if __name__ == '__main__': unittest.main()
