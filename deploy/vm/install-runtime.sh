#!/usr/bin/env bash
# Isolated user-level runtime; never replaces /usr/bin/node or edits shell startup files.
set -euo pipefail
umask 077
[[ "$(uname -s)" == Linux && "$(uname -m)" == aarch64 ]] || { printf 'Expected Linux ARM64\n' >&2; exit 1; }
PREFIX="$HOME/.local/opt/companion"
CACHE="$HOME/.cache/companion-deploy"
NODE_VERSION=24.22.2
NODE_SHA256=eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8
DSH_VERSION=0.2.1-rc.3
PNPM_VERSION=10.30.0
NODE_HOME="$PREFIX/node-v$NODE_VERSION-linux-arm64"
RUNTIME="$PREFIX/dsh-$DSH_VERSION"
ARCHIVE="$CACHE/node-v$NODE_VERSION-linux-arm64.tar.xz"
# First-install only: reject existing tools before changing any runtime package.
for tool in node npm pnpm dsh; do
  [[ ! -e "$PREFIX/bin/$tool" && ! -L "$PREFIX/bin/$tool" ]] || { printf 'Existing runtime requires inspection; do not rerun first-install: %s\n' "$PREFIX/bin/$tool" >&2; exit 1; }
done
mkdir -p "$PREFIX" "$CACHE" "$PREFIX/bin"
if [[ ! -f "$ARCHIVE" ]]; then
  curl --fail --silent --show-error --location --connect-timeout 15 --max-time 300 \
    "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz" --output "$ARCHIVE"
fi
printf '%s  %s\n' "$NODE_SHA256" "$ARCHIVE" | sha256sum --check --status
printf 'Verified official Node %s ARM64 archive\n' "$NODE_VERSION"
if [[ ! -x "$NODE_HOME/bin/node" ]]; then
  [[ ! -e "$NODE_HOME" ]] || { printf 'Existing partial Node directory requires inspection: %s\n' "$NODE_HOME" >&2; exit 1; }
  tar -xJf "$ARCHIVE" -C "$PREFIX" --no-same-owner
fi
export PATH="$NODE_HOME/bin:$PREFIX/bin:$PATH"
mkdir -p "$RUNTIME"
"$NODE_HOME/bin/node" "$NODE_HOME/lib/node_modules/npm/bin/npm-cli.js" install \
  --prefix "$RUNTIME" --save-exact --ignore-scripts --no-fund --no-audit \
  --fetch-timeout=120000 --fetch-retries=2 \
  "@deepseek-ai/dsh@$DSH_VERSION" "pnpm@$PNPM_VERSION"
ln -s "$NODE_HOME/bin/node" "$PREFIX/bin/node"
printf '#!/usr/bin/env bash\nexec "%s" "%s" "$@"\n' "$NODE_HOME/bin/node" "$NODE_HOME/lib/node_modules/npm/bin/npm-cli.js" > "$PREFIX/bin/npm"
printf '#!/usr/bin/env bash\nexec "%s" "%s" "$@"\n' "$NODE_HOME/bin/node" "$RUNTIME/node_modules/pnpm/bin/pnpm.cjs" > "$PREFIX/bin/pnpm"
printf '#!/usr/bin/env bash\nexport PATH="%s/bin:%s/bin:$PATH"\nexec "%s" "%s" "$@"\n' "$PREFIX" "$NODE_HOME" "$NODE_HOME/bin/node" "$RUNTIME/node_modules/@deepseek-ai/dsh/lib/bin.js" > "$PREFIX/bin/dsh"
chmod 700 "$PREFIX/bin/npm" "$PREFIX/bin/pnpm" "$PREFIX/bin/dsh"
"$PREFIX/bin/node" --version
"$PREFIX/bin/pnpm" --version
"$PREFIX/bin/dsh" --version
printf 'Runtime installed under %s (system Node unchanged)\n' "$PREFIX"
