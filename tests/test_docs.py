import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


docs = load('check_docs')
packages = load('package_release')
URL = 'https://github.com/outrobrunoai/novel-tts/blob/main'


def tree(files):
    """Build a throwaway documentation tree; returns its root."""
    directory = tempfile.TemporaryDirectory()
    root = Path(directory.name)
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
    return directory, root


class RepositoryDocumentationTests(unittest.TestCase):
    def test_links_anchors_and_file_name_case_resolve(self):
        self.assertEqual(docs.check_links(ROOT), [])

    def test_documents_have_clean_whitespace(self):
        # `git diff --check` skips untracked files, so a new document hid its blank line at EOF.
        self.assertEqual(docs.check_whitespace(ROOT), [])

    def test_packaged_documents_only_reference_what_the_package_contains(self):
        self.assertEqual(docs.check_packages(ROOT, packages.EXTENSION, packages.HOST), [])

    def test_the_command_line_entry_point_succeeds_on_the_repository(self):
        self.assertEqual(docs.main(ROOT), 0)


class LinkCheckerTests(unittest.TestCase):
    def check(self, files):
        directory, root = tree(files)
        with directory:
            return docs.check_links(root)

    def test_valid_relative_links_anchors_and_html_attributes_pass(self):
        self.assertEqual(self.check({
            'README.md': '# Título\n[guia](docs/GUIDE.md#instalação) [topo](#título)\n<a href="docs/GUIDE.md">x</a>\n'
                         '<img src="icon.svg">\n',
            'docs/GUIDE.md': '# Guia\n## Instalação\n[voltar](../README.md)\n',
            'icon.svg': '<svg/>'}), [])

    def test_missing_file_wrong_case_and_missing_anchor_are_reported(self):
        problems = self.check({
            'README.md': '[a](docs/MISSING.md) [b](docs/guide.md) [c](docs/GUIDE.md#nao-existe) [d](#sem-titulo)\n',
            'docs/GUIDE.md': '# Guia\n'})
        self.assertEqual(len(problems), 4, problems)
        self.assertTrue(all(problem.startswith('README.md:') for problem in problems))

    def test_duplicate_headings_get_numbered_anchors_and_code_fences_are_ignored(self):
        self.assertEqual(self.check({
            'README.md': '[x](#uso-1)\n# Uso\n## Uso\n```sh\n# not a heading\n[y](nowhere.md)\n```\n'}), [])
        self.assertEqual(len(self.check({'README.md': '[x](#not-a-heading)\n```sh\n# not a heading\n```\n'})), 1)

    def test_external_links_are_not_followed(self):
        self.assertEqual(self.check({'README.md': '[x](https://example.test/a) [y](mailto:a@b.test)\n'}), [])


class WhitespaceCheckerTests(unittest.TestCase):
    def check(self, text):
        directory, root = tree({'README.md': text})
        with directory:
            return docs.check_whitespace(root)

    def test_a_single_final_newline_without_trailing_spaces_passes(self):
        self.assertEqual(self.check('# A\n\ntext\n'), [])

    def test_extra_blank_line_at_end_missing_newline_and_trailing_space_are_reported(self):
        self.assertEqual(len(self.check('# A\n\n')), 1)
        self.assertEqual(len(self.check('# A')), 1)
        self.assertEqual(len(self.check('# A \n')), 1)


class PackageDocumentationTests(unittest.TestCase):
    def check(self, files, shipped=('HOST.md', 'LICENSE')):
        directory, root = tree(files)
        with directory:
            return docs.check_packages(root, (), shipped)

    def test_references_to_unshipped_documents_must_be_absolute_links(self):
        base = {'HOST.md': '', 'SECURITY.md': '# S\n', 'docs/GUIDE.md': '# G\n', 'README.md': '# R\n'}
        bare = self.check({**base, 'HOST.md': 'see `SECURITY.md` and docs/GUIDE.md\n'})
        self.assertEqual(len(bare), 2, bare)
        linked = self.check({**base, 'HOST.md': f'see [`SECURITY.md`]({URL}/SECURITY.md) and '
                                                f'[guide]({URL}/docs/GUIDE.md)\n'})
        self.assertEqual(linked, [])

    def test_a_document_may_name_itself_and_other_shipped_documents(self):
        files = {'HOST.md': 'HOST.md and PRIVACY.md are here\n', 'PRIVACY.md': '# P\n', 'README.md': '# R\n'}
        self.assertEqual(self.check(files, shipped=('HOST.md', 'PRIVACY.md', 'LICENSE')), [])

    def test_a_longer_name_does_not_count_as_a_mention_of_a_shorter_one(self):
        self.assertEqual(self.check({'HOST.md': 'see HOST_README.md\n', 'README.md': '# R\n'}), [])

    def test_relative_links_must_resolve_inside_the_package(self):
        problems = self.check({'HOST.md': '[a](SECURITY.md) [b](LICENSE)\n', 'SECURITY.md': '# S\n', 'README.md': '# R\n'})
        self.assertEqual(len(problems), 1, problems)
        self.assertIn('SECURITY.md', problems[0])


if __name__ == '__main__':
    unittest.main()
