#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
python3 -W error::ResourceWarning -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.cjs
python3 -m py_compile companion_server.py nlr_config.py novel_tts.py scripts/*.py
for file in ./*.js; do node --check "$file"; done
node --check vendor/pdf.mjs && node --check vendor/pdf.worker.mjs
python3 - <<'PY'
import json
from pathlib import Path
m = json.loads(Path('manifest.json').read_text())
for name in m.get('background', {}).get('scripts', []):
    if not Path(name).is_file(): raise SystemExit(f'manifest references missing file: {name}')
print(f"manifest: OK ({m['version']})")
PY
if command -v ruff >/dev/null 2>&1; then ruff check .; else echo 'missing required tool: ruff' >&2; exit 2; fi
if [ -x node_modules/.bin/eslint ]; then npx --no-install eslint .; else echo 'missing local tool: eslint (run npm ci)' >&2; exit 2; fi
if [ -x node_modules/.bin/web-ext ]; then npx --no-install web-ext lint --ignore-files 'vendor/**'; else echo 'missing local tool: web-ext (run npm ci)' >&2; exit 2; fi
if command -v shellcheck >/dev/null 2>&1; then shellcheck install-service.sh scripts/*.sh; else echo 'missing required tool: shellcheck' >&2; exit 2; fi
python3 scripts/check_publication.py
python3 scripts/check_versions.py
release_tmp=$(mktemp -d)
trap 'rm -rf "$release_tmp"' EXIT
python3 scripts/package_release.py --output "$release_tmp/build-a"
python3 scripts/package_release.py --output "$release_tmp/build-b"
python3 scripts/check_versions.py --artifacts "$release_tmp/build-a"
for artifact in "$release_tmp/build-a"/*; do
  cmp "$artifact" "$release_tmp/build-b/$(basename -- "$artifact")"
done
python3 scripts/inspect_release.py --directory "$release_tmp/build-a"
mkdir "$release_tmp/extension-extracted"
extension_zip="$release_tmp/build-a/$(python3 scripts/release_asset.py extension "$release_tmp/build-a")"
python3 - "$extension_zip" "$release_tmp/extension-extracted" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2])
PY
npx --no-install web-ext lint --source-dir "$release_tmp/extension-extracted" --ignore-files 'vendor/**'
node --check "$release_tmp/extension-extracted/vendor/pdf.mjs"
node --check "$release_tmp/extension-extracted/vendor/pdf.worker.mjs"
git diff --check
echo 'verification: OK'
