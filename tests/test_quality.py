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
            (root / 'docs').mkdir()
            names = ('novel_tts.py', 'companion_server.py', 'protocol.js', 'content-panel.js',
                     'content.js', 'README.md', 'TESTING.md', 'RELEASE_NOTES.md', 'docs/GUIDE.md')
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
            self.assertEqual(checker.check(root), 1)  # docs/GUIDE.md still names no version
            (root / 'docs/GUIDE.md').write_text('Guia 1.4.0')
            self.assertEqual(checker.check(root), 0)
            (root / 'content-panel.js').write_text('<span class="nlr-version">1.5.0</span>')
            self.assertEqual(checker.check(root), 1)

    def test_required_workflow_and_local_command_exist(self):
        self.assertTrue((ROOT / '.github/workflows/ci.yml').exists())
        self.assertTrue((ROOT / 'scripts/verify.sh').exists())
        self.assertTrue((ROOT / 'scripts/check_docs.py').exists())
        for gate in ('scripts/verify.sh', '.github/workflows/ci.yml'):
            self.assertIn('scripts/check_docs.py', (ROOT / gate).read_text(), gate)

    def test_public_documents_carry_no_internal_process_notes_or_personal_paths(self):
        forbidden = re.compile(
            r'checkpoint|FASE \d|AMO reviewer|revisor AMO|n[ãa]o tem remote|ainda n[ãa]o tem remote|'
            r'point elsewhere|apontar para outro|/mnt/|/home/[a-z]', re.IGNORECASE)
        for document in sorted([*ROOT.glob('*.md'), *ROOT.glob('docs/*.md')]):
            if document.name == 'CLAUDE.md':
                continue  # local agent notes; never tracked or published
            hits = [m.group(0) for m in forbidden.finditer(document.read_text())]
            self.assertEqual(hits, [], str(document.relative_to(ROOT)))

    def test_documented_facts_match_what_users_actually_get(self):
        text = {name: (ROOT / name).read_text() for name in (
            'README.md', 'docs/GUIDE.md', 'HOST_README.md', 'RELEASE_NOTES.md', 'SECURITY.md',
            'PRIVACY_POLICY.md', 'THIRD_PARTY_NOTICES.md', 'ROADMAP.md')}
        guide = text['docs/GUIDE.md']  # the complete reference; the README only introduces it
        # The units run /usr/bin/python3; a venv or conda `python3` may be another interpreter.
        for name in ('README.md', 'docs/GUIDE.md', 'HOST_README.md', 'RELEASE_NOTES.md'):
            self.assertNotRegex(text[name], r'(?<!/bin/)python3 novel_tts\.py upgrade', name)
        for name in ('docs/GUIDE.md', 'HOST_README.md', 'RELEASE_NOTES.md'):
            self.assertIn('/usr/bin/python3 novel_tts.py upgrade', text[name], name)
        for code in ('NLR_QWEN_PORT_CONFLICT', 'NLR_CACHE_HEALTH_FAILED'):
            self.assertIn(code, guide)
        for name in ('docs/GUIDE.md', 'HOST_README.md'):
            self.assertRegex(text[name], r'setup`? ou `?upgrade', name)  # what `rollback` undoes
        for name in ('README.md', 'docs/GUIDE.md', 'HOST_README.md'):
            self.assertNotRegex(text[name], r'(?i)mostra o plano,? (e )?pede|mostra o plano, pede', name)
        # The engine on 8080 has no authentication and allows any origin. Say so where people read
        # about security, where they land, and in the package that installs it.
        for name in ('README.md', 'SECURITY.md', 'PRIVACY_POLICY.md', 'HOST_README.md', 'ROADMAP.md'):
            self.assertIn('CORS', text[name], name)
        for name in ('README.md', 'SECURITY.md'):
            self.assertRegex(text[name], r'(?i)não exige autenticação|does not authenticate', name)
        notes = ' '.join(text['RELEASE_NOTES.md'].split())  # hard-wrapped lines
        fixes = notes.split('## Correções')[1].split('## Atualizando')[0]
        known = notes.split('## Problemas conhecidos')[1]
        self.assertIn('pré-geração exige um link', notes)
        self.assertIn('antes uma instalação nova não conseguia gravar o cache', notes)
        self.assertIn('não tem autenticação', known)  # listed as a known problem...
        self.assertNotIn('CORS', fixes)               # ...and never presented as fixed
        self.assertNotIn('Novel Local Reader source', text['THIRD_PARTY_NOTICES.md'])
        self.assertIn('CORS', text['ROADMAP.md'])
        # Where the installation steps live now: shipped notices must not send people to the README.
        self.assertNotRegex(text['THIRD_PARTY_NOTICES.md'], r'\bREADME\b')
        self.assertNotRegex(text['HOST_README.md'], r'(?i)\bno README\b|\bREADME do repositório')
        self.assertIn('/docs/GUIDE.md', text['HOST_README.md'])

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

    def test_javascript_tests_run_on_the_ci_node_and_on_the_newest_node(self):
        # Developing on a newer Node than CI hid a missing built-in for months; test both.
        text = (ROOT / '.github/workflows/ci.yml').read_text()
        javascript = text.split('  javascript:')[1].split('\n  security:')[0]
        self.assertRegex(javascript, r"node-version: \['24', '26'\]")
        self.assertIn('matrix.node-version', javascript)

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
