#!/usr/bin/env bash
# Smoke-tests every bundle `just desktop-package --target <triple>` made, as users get them: on
# macOS the app and the app inside the dmg, on Windows the NSIS installer (installed into a
# temporary folder), on Linux the AppImage and the deb, headless under xvfb.
# Usage: scripts/ci/smoke.sh <triple>
set -euo pipefail

triple="${1:?usage: $0 <triple>}"
bundle="${CARGO_TARGET_DIR:-src-tauri/target}/$triple/release/bundle"

shopt -s nullglob
flags=(--target "$triple")
case "$triple" in
  *-apple-darwin) artifacts=("$bundle"/macos/*.app "$bundle"/dmg/*.dmg) want=2 ;;
  *-unknown-linux-gnu)
    artifacts=("$bundle"/appimage/*.AppImage "$bundle"/deb/*.deb) want=2
    flags+=(--headless)
    ;;
  *-pc-windows-msvc) artifacts=("$bundle"/nsis/*-setup.exe) want=1 ;;
  *)
    echo "::error title=Smoke test::No smoke test for $triple."
    exit 1
    ;;
esac
if [[ "${#artifacts[@]}" != "$want" ]]; then
  echo "::error title=Smoke test::Expected $want bundles in $bundle, found ${#artifacts[@]}: ${artifacts[*]:-none}."
  exit 1
fi

for artifact in "${artifacts[@]}"; do
  echo "::group::Smoke test of $artifact"
  just desktop-smoke "$artifact" "${flags[@]}"
  echo "::endgroup::"
done
