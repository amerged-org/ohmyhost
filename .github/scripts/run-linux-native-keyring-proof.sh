#!/usr/bin/env bash
set -euo pipefail

proof_root="$(mktemp -d)"
daemon_pid=""
cleanup() {
  if [[ -n "$daemon_pid" ]]; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  rm -rf "$proof_root"
}
trap cleanup EXIT
umask 077

openssl rand -base64 48 >"$proof_root/unlock"
gnome-keyring-daemon --foreground --components=secrets --unlock \
  <"$proof_root/unlock" >/dev/null 2>&1 &
daemon_pid="$!"
rm -f "$proof_root/unlock"

for _ in {1..50}; do
  if dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply \
    /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner \
    string:org.freedesktop.secrets 2>/dev/null | grep -q true; then
    pnpm phase1:credential-store-platform-proof -- --stage-output native-proof/linux
    exit 0
  fi
  sleep 0.1
done

exit 2
