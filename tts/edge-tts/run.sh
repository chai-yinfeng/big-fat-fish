#!/usr/bin/env bash
# Start the standalone edge-tts HTTP service.
#
# uv owns the virtualenv (.venv) and the locked dependency set (uv.lock).
# The service is independent of DSH; the companion adapters plugin only talks
# to it over HTTP.
set -euo pipefail
cd "$(dirname "$0")"
# Keep uv's cache next to the project so the service also works when the host
# filesystem policy only permits writes under the workspace.
export UV_CACHE_DIR="${UV_CACHE_DIR:-$PWD/.uv-cache}"
exec uv run --frozen --no-dev -q server.py "$@"
