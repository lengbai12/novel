#!/usr/bin/env bash
set -euo pipefail
ROOT="$(dirname "$(readlink -f "$0")")"
export PYTHONDONTWRITEBYTECODE=1
exec python3 "$ROOT/novel_app.py" "$@"
