#!/usr/bin/env bash
# Smoke-tests every bundle `just desktop-package --target <triple>` made, as users get them: on
# macOS the app and the app inside the dmg, on Windows the NSIS installer (installed into a
# temporary folder), on Linux the AppImage and the deb, headless under xvfb.
#
# Given a folder of release files instead, as scripts/ci/collect-bundles.sh names them (the
# release workflow's smoke job), it tests those: on macOS the dmg and the app unpacked from the
# update archive, elsewhere the same files as above.
# Usage: scripts/ci/smoke.sh <triple> [<release files>]
set -euo pipefail

triple="${1:?usage: $0 <triple> [<release files>]}"
files="${2:-}"
bundle="${CARGO_TARGET_DIR:-apps/desktop/src-tauri/target}/$triple/release/bundle"

shopt -s nullglob
artifacts=()
# Adds the one entry of folder $1 whose name ends in $2, and stops at none or several.
take() {
  local found=() entry
  for entry in "$1"/*; do
    if [[ "$entry" == *"$2" ]]; then
      found+=("$entry")
    fi
  done
  if [[ "${#found[@]}" != 1 ]]; then
    echo "::error title=Smoke test::Expected one $2 in $1, found ${#found[@]}: ${found[*]:-none}."
    exit 1
  fi
  artifacts+=("${found[0]}")
}

flags=(--target "$triple")
case "$triple" in
  *-apple-darwin)
    if [[ -n "$files" ]]; then
      take "$files" .app.tar.gz
      # A real path: Tauri refuses to find its resources through a symlink, as /tmp is.
      unpacked="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/pr-quest-update.XXXXXX")" && pwd -P)"
      trap 'rm -rf "$unpacked"' EXIT
      tar -xzf "${artifacts[0]}" -C "$unpacked"
      artifacts=()
      take "$unpacked" .app
      take "$files" .dmg
    else
      take "$bundle/macos" .app
      take "$bundle/dmg" .dmg
    fi
    ;;
  *-unknown-linux-gnu)
    if [[ -n "$files" ]]; then
      take "$files" .AppImage
      # Artifacts don't keep the executable bit.
      chmod +x "${artifacts[0]}"
      take "$files" .deb
    else
      take "$bundle/appimage" .AppImage
      take "$bundle/deb" .deb
    fi
    flags+=(--headless)
    ;;
  *-pc-windows-msvc) take "${files:-$bundle/nsis}" -setup.exe ;;
  *)
    echo "::error title=Smoke test::No smoke test for $triple."
    exit 1
    ;;
esac

for artifact in "${artifacts[@]}"; do
  echo "::group::Smoke test of $artifact"
  just desktop-smoke "$artifact" "${flags[@]}"
  echo "::endgroup::"
done
