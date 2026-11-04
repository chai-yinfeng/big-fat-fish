#!/usr/bin/env bash
# Start the local ASR gateway. uv owns the virtualenv and locked deps.
set -euo pipefail
cd "$(dirname "$0")"
export UV_CACHE_DIR="${UV_CACHE_DIR:-$PWD/.uv-cache}"
exec uv run --frozen --no-dev -q server.py "$@"
