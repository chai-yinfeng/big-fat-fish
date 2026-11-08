#!/usr/bin/env bash
# Isolated user-level runtime; never replaces /usr/bin/node or edits shell startup files.
set -euo pipefail
umask 077
[[ "$(uname -s)" == Linux ]] || { printf 'Expected Linux\n' >&2; exit 1; }
PREFIX="$HOME/.local/opt/companion"
CACHE="$HOME/.cache/companion-deploy"
NODE_VERSION=24.22.2
# Official https://nodejs.org/dist/v24.22.2/SHASUMS256.txt entries.
case "$(uname -m)" in
  aarch64) NODE_ARCH=arm64; NODE_SHA256=eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8 ;;
  x86_64) NODE_ARCH=x64; NODE_SHA256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75 ;;
  *) printf 'Expected Linux ARM64 or x86_64\n' >&2; exit 1 ;;
esac
NODE_HOME="$PREFIX/node-v$NODE_VERSION-linux-$NODE_ARCH"
ARCHIVE="$CACHE/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
# First-install only: reject existing tools before changing any runtime package.
for tool in node npm; do
  [[ ! -e "$PREFIX/bin/$tool" && ! -L "$PREFIX/bin/$tool" ]] || { printf 'Existing runtime requires inspection; do not rerun first-install: %s\n' "$PREFIX/bin/$tool" >&2; exit 1; }
done
mkdir -p "$PREFIX" "$CACHE" "$PREFIX/bin"
if [[ ! -f "$ARCHIVE" ]]; then
  curl --fail --silent --show-error --location --connect-timeout 15 --max-time 300 \
    "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz" --output "$ARCHIVE"
fi
printf '%s  %s\n' "$NODE_SHA256" "$ARCHIVE" | sha256sum --check --status
printf 'Verified official Node %s %s archive\n' "$NODE_VERSION" "$NODE_ARCH"
if [[ ! -x "$NODE_HOME/bin/node" ]]; then
  [[ ! -e "$NODE_HOME" ]] || { printf 'Existing partial Node directory requires inspection: %s\n' "$NODE_HOME" >&2; exit 1; }
  tar -xJf "$ARCHIVE" -C "$PREFIX" --no-same-owner
fi
ln -s "$NODE_HOME/bin/node" "$PREFIX/bin/node"
printf '#!/usr/bin/env bash\nexec "%s" "%s" "$@"\n' "$NODE_HOME/bin/node" "$NODE_HOME/lib/node_modules/npm/bin/npm-cli.js" > "$PREFIX/bin/npm"
chmod 700 "$PREFIX/bin/npm"
"$PREFIX/bin/node" --version
printf 'Runtime installed under %s (system Node unchanged)\n' "$PREFIX"
