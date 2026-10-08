#!/usr/bin/env python3
"""Print the file name of one artifact type listed in release-manifest.json."""
import json
import sys
from pathlib import Path


def main(argv):
    if len(argv) != 3 or argv[1] not in ('extension', 'host'):
        print('uso: release_asset.py extension|host DIRETÓRIO', file=sys.stderr)
        return 2
    manifest = json.loads((Path(argv[2]) / 'release-manifest.json').read_text(encoding='utf-8'))
    print(next(item['name'] for item in manifest['artifacts'] if item['type'] == argv[1]))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
