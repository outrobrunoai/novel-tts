import importlib.util
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / f'{name}.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

class QualityTests(unittest.TestCase):
    def test_publication_check_reports_category_without_reading_content(self):
        checker = load('check_publication')
        with patch.object(checker, 'tracked', return_value=['private/model.gguf', 'src/app.js']):
            with patch('builtins.print') as output:
                self.assertEqual(checker.main(), 1)
        message = output.call_args.args[0]
        self.assertEqual(message, 'prohibited tracked file: private/model.gguf [model]')
        self.assertNotIn('model-A', message)

    def test_publication_check_healthy_tree(self):
        checker = load('check_publication')
        with patch.object(checker, 'tracked', return_value=['README.md', 'src/app.js']):
            self.assertEqual(checker.main(), 0)

    def test_version_check_matches_manifest(self):
        checker = load('check_versions')
        self.assertEqual(checker.check(ROOT), 0)

    def test_version_check_rejects_each_missing_or_divergent_source(self):
        checker = load('check_versions')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'manifest.json').write_text('{"version":"1.4.0"}')
            names = ('novel_tts.py', 'companion_server.py', 'protocol.js', 'content-panel.js',
                     'content.js', 'README.md', 'TESTING.md', 'RELEASE_NOTES.md')
            for name in names:
                (root / name).write_text('wrong')
            self.assertEqual(checker.check(root), 1)
            (root / 'novel_tts.py').write_text("VERSION = '1.4.0'")
            (root / 'companion_server.py').write_text("APP_VERSION = '1.4.0'")
            (root / 'protocol.js').write_text('APP_VERSION = "1.4.0"')
            (root / 'content-panel.js').write_text('<span class="nlr-version">1.4.0</span>')
            (root / 'content.js').write_text("version:'1.4.0'")
            (root / 'README.md').write_text('release 1.4.0')
            self.assertEqual(checker.check(root), 1)
            (root / 'TESTING.md').write_text('Validation 1.4.0')
            (root / 'RELEASE_NOTES.md').write_text('Release 1.4.0')
            self.assertEqual(checker.check(root), 0)
            (root / 'content-panel.js').write_text('<span class="nlr-version">1.5.0</span>')
            self.assertEqual(checker.check(root), 1)

    def test_required_workflow_and_local_command_exist(self):
        self.assertTrue((ROOT / '.github/workflows/ci.yml').exists())
        self.assertTrue((ROOT / 'scripts/verify.sh').exists())

    def test_public_documents_carry_no_internal_process_notes_or_personal_paths(self):
        forbidden = re.compile(
            r'checkpoint|FASE \d|AMO reviewer|revisor AMO|n[ãa]o tem remote|ainda n[ãa]o tem remote|'
            r'point elsewhere|apontar para outro|/mnt/|/home/[a-z]', re.IGNORECASE)
        for document in sorted(ROOT.glob('*.md')):
            if document.name == 'CLAUDE.md':
                continue  # local agent notes; never tracked or published
            hits = [m.group(0) for m in forbidden.finditer(document.read_text())]
            self.assertEqual(hits, [], document.name)

    def test_documented_facts_match_what_users_actually_get(self):
        text = {name: (ROOT / name).read_text() for name in (
            'README.md', 'HOST_README.md', 'RELEASE_NOTES.md', 'SECURITY.md', 'PRIVACY_POLICY.md',
            'THIRD_PARTY_NOTICES.md', 'ROADMAP.md')}
        for name in ('README.md', 'HOST_README.md', 'RELEASE_NOTES.md'):
            # The units run /usr/bin/python3; a venv or conda `python3` may be another interpreter.
            self.assertNotRegex(text[name], r'(?<!/bin/)python3 novel_tts\.py upgrade', name)
            self.assertIn('/usr/bin/python3 novel_tts.py upgrade', text[name], name)
        for code in ('NLR_QWEN_PORT_CONFLICT', 'NLR_CACHE_HEALTH_FAILED'):
            self.assertIn(code, text['README.md'])
        for name in ('README.md', 'HOST_README.md'):
            self.assertRegex(text[name], r'setup`? ou `?upgrade', name)  # what `rollback` undoes
            self.assertNotRegex(text[name], r'(?i)mostra o plano,? (e )?pede|mostra o plano, pede', name)
        for name in ('SECURITY.md', 'PRIVACY_POLICY.md', 'README.md'):
            self.assertIn('CORS', text[name], name)  # the engine on 8080 has no auth and allows any origin
        notes = ' '.join(text['RELEASE_NOTES.md'].split())  # hard-wrapped lines
        self.assertIn('pré-geração exige um link', notes)
        self.assertIn('antes uma instalação nova não conseguia gravar o cache', notes)
        self.assertNotIn('Novel Local Reader source', text['THIRD_PARTY_NOTICES.md'])
        self.assertIn('CORS', text['ROADMAP.md'])

    def workflows(self):
        return sorted((ROOT / '.github/workflows').glob('*.yml'))

    def test_every_workflow_pins_actions_to_a_full_commit_sha(self):
        for workflow in self.workflows():
            for number, line in enumerate(workflow.read_text().splitlines(), 1):
                match = re.match(r'\s*-?\s*uses:\s*(\S+)', line)
                if match:
                    self.assertRegex(match.group(1), r'@[0-9a-f]{40}$', f'{workflow.name}:{number}')

    @staticmethod
    def run_bodies(text):
        """Yield the shell text of every `run:` step, inline or block."""
        lines = text.splitlines()
        for index, line in enumerate(lines):
            match = re.match(r'(\s*)(- )?run:\s*(.*)$', line)
            if not match:
                continue
            indent = len(match.group(1)) + (2 if match.group(2) else 0)
            body = [match.group(3)]
            for follow in lines[index + 1:]:
                if follow.strip() and len(follow) - len(follow.lstrip()) <= indent:
                    break
                body.append(follow)
            yield '\n'.join(body)

    def test_workflow_scripts_never_interpolate_expressions(self):
        # `${{ ... }}` inside a script is an injection vector; values travel through env.
        for workflow in self.workflows():
            offenders = [body for body in self.run_bodies(workflow.read_text()) if '${{' in body]
            self.assertEqual(offenders, [], workflow.name)

    def test_release_workflow_publishes_only_a_draft_and_keeps_secrets_out_of_scripts(self):
        text = (ROOT / '.github/workflows/release.yml').read_text()
        self.assertRegex(text, r"(?m)^\s*tags:\s*\['v\*'\]")
        self.assertIn('--channel unlisted', text)
        self.assertIn('gh release create', text)
        self.assertIn('--draft', text)
        # The signing secret is read once, through step-level env.
        self.assertEqual(len(re.findall(r'secrets\.AMO_JWT_SECRET', text)), 1)
        self.assertNotIn('--api-secret', text)

if __name__ == '__main__': unittest.main()
