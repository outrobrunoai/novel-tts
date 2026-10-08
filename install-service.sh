#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# The systemd units run /usr/bin/python3, so that is the interpreter to check.
if ! /usr/bin/python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
  echo 'Este host requer /usr/bin/python3 na versão 3.10 ou superior.' >&2
  exit 1
fi
exec /usr/bin/python3 "$SCRIPT_DIR/novel_tts.py" install "$@"
