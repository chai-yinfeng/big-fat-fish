#!/usr/bin/env bash
# Run on home-agent (as the proxy's own user, no sudo) from a copy of deploy/home-agent-proxy/.
# Installs a new release directory next to the old ones, switches the units and the command entry,
# and switches back automatically when the new release cannot reach a download host.
set -Eeuo pipefail
umask 077

usage='Usage: bash install-runtime.sh <mihomo-linux-amd64-compatible-v1.19.33.gz | installed mihomo binary> --yes'
if [[ $# -ne 2 || "$2" != --yes ]]; then
  echo "$usage" >&2
  exit 2
fi
readonly source_file="$1"
readonly here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly version='v1.19.33'
readonly release_name="$(sed -n 's/^RELEASE = "\([A-Za-z0-9.-]*\)"$/\1/p' -- "$here/manage.py")"
readonly releases="${HOME}/.local/lib/home-agent-proxy/releases"
readonly release="${releases}/${release_name}"
readonly config="${HOME}/.config/home-agent-proxy"
readonly state="${HOME}/.local/state/home-agent-proxy"
readonly units="${HOME}/.config/systemd/user"
readonly entry="${HOME}/.local/bin/home-agent-proxy"
readonly unit_names=(home-agent-proxy.service home-agent-proxy-update.service home-agent-proxy-update.timer)
# Official release asset and the binary it unpacks to (see README).
readonly asset_sha='386508bfb1c72c43b6a0eda73708ecdce82546581b0ebcb16366c53757c622b6'
readonly binary_sha='817f50b3ac6a8b1c4360c5cf2961906057f3a883d970ebbcb0028a01632b620f'

[[ "$release_name" == "${version}-"* ]] || { echo 'proxy_release_name_invalid' >&2; exit 1; }
for unit in "${unit_names[@]}"; do
  if grep -q 'releases/' "$here/systemd/$unit" && ! grep -q "releases/${release_name}/" "$here/systemd/$unit"; then
    echo 'proxy_unit_release_mismatch' >&2; exit 1
  fi
done
[[ "$(uname -s) $(uname -m)" == 'Linux x86_64' ]] || { echo 'proxy_environment_unsupported' >&2; exit 1; }
[[ -f "$source_file" && ! -L "$source_file" ]] || { echo 'proxy_archive_invalid' >&2; exit 1; }
python3 -c 'import yaml' >/dev/null 2>&1 || { echo 'proxy_pyyaml_missing' >&2; exit 1; }
[[ "$(loginctl show-user "$(id -u)" -p Linger --value)" == yes ]] || { echo 'proxy_user_linger_required' >&2; exit 1; }

for directory in "$releases" "$release" "$config" "$state" "$state/core" "$state/recovery" "$units" "$HOME/.local/bin"; do
  [[ ! -L "$directory" ]] || { echo 'proxy_directory_conflict' >&2; exit 1; }
  mkdir -p -- "$directory"
done
chmod 0700 -- "$releases" "$release" "$config" "$state" "$state/core" "$state/recovery"

# Never overwrite an unrelated or manually modified file inside a release.
install_exact() {
  local source="$1" destination="$2" mode="$3"
  if [[ -e "$destination" || -L "$destination" ]]; then
    [[ -f "$destination" && ! -L "$destination" ]] && cmp -s -- "$source" "$destination" || {
      echo 'proxy_install_path_conflict' >&2; return 1;
    }
  else
    install -m "$mode" -- "$source" "$destination"
  fi
}

binary_stage="$(mktemp "${release}/.binary-XXXXXXXX")"
trap 'rm -f -- "$binary_stage"' EXIT
source_sha="$(sha256sum -- "$source_file" | cut -d ' ' -f 1)"
if [[ "$source_sha" == "$asset_sha" ]]; then
  gzip -cd -- "$source_file" >"$binary_stage"
elif [[ "$source_sha" == "$binary_sha" ]]; then
  cat -- "$source_file" >"$binary_stage"
else
  echo 'proxy_asset_integrity_mismatch' >&2; exit 1
fi
[[ "$(sha256sum -- "$binary_stage" | cut -d ' ' -f 1)" == "$binary_sha" ]] || { echo 'proxy_asset_integrity_mismatch' >&2; exit 1; }
chmod 0700 -- "$binary_stage"
"$binary_stage" -v | python3 -c 'import sys; sys.exit(0 if "v1.19.33" in sys.stdin.read() else 1)'
install_exact "$binary_stage" "$release/mihomo" 0700
install_exact "$here/manage.py" "$release/helper.py" 0700
manifest="$(mktemp "${release}/.manifest-XXXXXXXX")"
( cd -- "$release" && sha256sum mihomo helper.py ) >"$manifest"
( cd -- "$here/systemd" && sha256sum -- "${unit_names[@]}" ) >>"$manifest"
install_exact "$manifest" "$release/SHA256SUMS" 0600
rm -f -- "$manifest"

# Keep the previous units and entry target so the switch can be undone (README "回滚").
previous=''
if [[ -L "$entry" ]]; then
  previous="$(readlink -- "$entry")"
  [[ "$previous" == "$releases/"*/helper.py && -f "$previous" ]] || { echo 'proxy_entry_conflict' >&2; exit 1; }
elif [[ -e "$entry" ]]; then
  echo 'proxy_entry_conflict' >&2; exit 1
fi
backup=''
if [[ -n "$previous" && "$previous" != "$release/helper.py" ]]; then
  backup="$state/recovery/$(date -u +%Y%m%dT%H%M%SZ)-units"
  mkdir -m 0700 -- "$backup"
  for unit in "${unit_names[@]}"; do
    [[ ! -e "$units/$unit" ]] || cp -p -- "$units/$unit" "$backup/$unit"
  done
  printf '%s\n' "$previous" >"$backup/previous-entry"
fi

switch_units() {
  local from="$1" unit
  for unit in "${unit_names[@]}"; do
    install -m 0644 -- "$from/$unit" "$units/.$unit.new"
    mv -f -- "$units/.$unit.new" "$units/$unit"
  done
}
point_entry() {
  ln -s -- "$1" "$entry.new"
  mv -Tf -- "$entry.new" "$entry"
}
roll_back() {
  if [[ -n "$backup" ]]; then
    switch_units "$backup"
    point_entry "$previous"
    systemctl --user daemon-reload
    systemctl --user restart home-agent-proxy.service || true
    systemctl --user enable home-agent-proxy-update.timer >/dev/null 2>&1 || true
    echo "proxy_rolled_back=true previous_release=$(basename -- "$(dirname -- "$previous")")" >&2
  else
    systemctl --user disable --now home-agent-proxy.service >/dev/null 2>&1 || true
  fi
}

fail() {
  trap - ERR
  roll_back
  echo "$1" >&2
  exit 1
}
trap 'fail proxy_install_step_failed' ERR
switch_units "$here/systemd"
point_entry "$release/helper.py"
systemctl --user daemon-reload
python3 "$release/helper.py" update || fail proxy_update_failed
systemctl --user enable home-agent-proxy.service >/dev/null
# Restart so the unit runs this release's binary even when the configuration did not change.
systemctl --user restart home-agent-proxy.service

# An active process is insufficient: demand a verified HTTPS response through it.
ready=false
for attempt in 1 2 3; do
  code="$(curl --silent --output /dev/null --proxy http://127.0.0.1:7890 --noproxy '' \
    --connect-timeout 10 --max-time 25 --write-out '%{http_code}' \
    https://registry-1.docker.io/v2/ || true)"
  if [[ "$code" == 401 ]]; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]] || fail proxy_upstream_verification_failed
systemctl --user enable --now home-agent-proxy-update.timer
python3 "$release/helper.py" status
printf '%s\n' "proxy_install_verified=true release=${release_name} docker_daemon_changed=false"
