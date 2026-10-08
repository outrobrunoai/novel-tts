#!/usr/bin/env python3
"""Reject tracked private/prohibited artifacts without printing their contents."""
import subprocess
import sys
from pathlib import PurePosixPath

PATTERNS = {'*.gguf': 'model', '*.spk': 'voice', '*.rvq': 'voice', '*.wav': 'audio', '*.mp3': 'audio', '*.flac': 'audio', '*.ogg': 'audio'}
NAMES = {'config.json', 'credentials.json', 'token', 'token.txt', 'id_rsa'}
WORDS = ('token', 'secret', 'credential', 'backup', 'cache', '.pem', '.key')

def category(path):
    name = PurePosixPath(path).name.lower()
    for pattern, value in PATTERNS.items():
        if PurePosixPath(name).match(pattern): return value
    if name in NAMES or any(word in name for word in WORDS): return 'credential/private data'
    if any(part in {'cache', 'backups', 'build', 'dist', '__pycache__'} for part in PurePosixPath(path).parts): return 'generated data'
    return None

def tracked(root):
    result = subprocess.run(['git', 'ls-files', '-z'], cwd=root, check=True, capture_output=True)
    return [item.decode() for item in result.stdout.split(b'\0') if item]

def main():
    failures = [(path, category(path)) for path in tracked('.') if category(path)]
    if failures:
        for path, kind in failures: print(f'prohibited tracked file: {path} [{kind}]')
        return 1
    print('publication hygiene: OK')
    return 0

if __name__ == '__main__': sys.exit(main())
