#!/usr/bin/env bash
# Start the standalone MiMo-V2.5-TTS HTTP service.
set -euo pipefail
cd "$(dirname "$0")"
exec node server.js "$@"
