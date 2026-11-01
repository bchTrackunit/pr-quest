#!/usr/bin/env bash
# Runs the smoke test on the app inside a dmg, as a user would start it after opening the dmg.
# Usage: scripts/smoke-dmg.sh release/pr-quest-<version>-mac-<arch>.dmg
set -euo pipefail

dmg="${1:?usage: $0 <dmg>}"
mount_point="$(mktemp -d "${TMPDIR:-/tmp}/pr-quest-dmg.XXXXXX")"
hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mount_point" "$dmg" >/dev/null
trap 'hdiutil detach -force "$mount_point" >/dev/null || true; rmdir "$mount_point" 2>/dev/null || true' EXIT

yarn desktop:smoke "$mount_point/PR Quest.app/Contents/MacOS/PR Quest"
