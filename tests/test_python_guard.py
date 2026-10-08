import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PythonGuardTests(unittest.TestCase):
    def test_host_refuses_an_old_interpreter_with_a_clear_message(self):
        code = ("import runpy, sys; sys.version_info = (3, 9, 18, 'final', 0); "
                "sys.argv = ['novel_tts.py', 'config']; "
                f"runpy.run_path({str(ROOT / 'novel_tts.py')!r}, run_name='__main__')")
        # Never read the developer's real configuration from this test.
        env = {**os.environ, 'NLR_CONFIG_PATH': '/nonexistent/novel-tts-test/config.json'}
        result = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True,
                                timeout=30, env=env)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Python 3.10', result.stderr)

    def test_the_script_is_a_real_process_boundary_with_a_nonzero_exit_and_no_traceback(self):
        with tempfile.TemporaryDirectory() as home:
            env = {**os.environ, 'HOME': home, 'XDG_CONFIG_HOME': home, 'XDG_CACHE_HOME': home,
                   'XDG_DATA_HOME': home, 'NLR_CONFIG_PATH': str(Path(home) / 'novel-local-reader/config.json')}
            result = subprocess.run([sys.executable, str(ROOT / 'novel_tts.py'), 'token'],
                                    capture_output=True, text=True, timeout=30, env=env)
        self.assertEqual(result.returncode, 1)
        self.assertIn('install-service.sh', result.stderr)
        self.assertNotIn('Traceback', result.stderr)
        self.assertNotIn(home, result.stderr)

    def test_installer_checks_the_interpreter_used_by_the_units(self):
        script = (ROOT / 'install-service.sh').read_text()
        self.assertIn("/usr/bin/python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))'", script)


if __name__ == '__main__':
    unittest.main()
