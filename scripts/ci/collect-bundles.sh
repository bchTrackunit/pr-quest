#!/usr/bin/env bash
# Copies what `just desktop-package --target <triple>` made into one folder, under the names the
# release publishes them as: no spaces, which GitHub would turn into dots, and each macOS update
# file named after its processor, since both are "PR Quest.app.tar.gz". With --updater, as for a
# release build, the update files and their .sig must be there too. Anything missing stops it.
# Usage: scripts/ci/collect-bundles.sh <triple> <version> <output folder> [--updater]
set -euo pipefail

triple="${1:?usage: $0 <triple> <version> <output folder> [--updater]}"
version="${2:?usage: $0 <triple> <version> <output folder> [--updater]}"
out="${3:?usage: $0 <triple> <version> <output folder> [--updater]}"
updater=false
if [[ "${4:-}" == --updater ]]; then
  updater=true
elif [[ -n "${4:-}" ]]; then
  echo "usage: $0 <triple> <version> <output folder> [--updater]" >&2
  exit 2
fi
bundle="${CARGO_TARGET_DIR:-src-tauri/target}/$triple/release/bundle"

fail() {
  echo "::error title=Bundles::$1"
  exit 1
}

# Copies bundle/<kind>/<name> to <out>/<asset>.
take() {
  local source="$bundle/$1/$2"
  if [[ ! -f "$source" ]]; then
    fail "$triple has no $1/$2; desktop-package made: $(find "$bundle" -maxdepth 2 -type f 2>/dev/null | sed "s|^$bundle/||" | sort | tr '\n' ' ')"
  fi
  if [[ -e "$out/$3" ]]; then
    fail "$out/$3 exists already."
  fi
  cp "$source" "$out/$3"
  echo "$1/$2 -> $3"
}

# An installer that is also the update file, or (for macOS) the update file alone.
take_updatable() {
  if [[ "$4" == installer || "$updater" == true ]]; then
    take "$1" "$2" "$3"
  fi
  if [[ "$updater" == true ]]; then
    take "$1" "$2.sig" "$3.sig"
  fi
}

mkdir -p "$out"
v="$version"
case "$triple" in
  aarch64-apple-darwin)
    take dmg "PR Quest_${v}_aarch64.dmg" "PR-Quest_${v}_aarch64.dmg"
    take_updatable macos "PR Quest.app.tar.gz" "PR-Quest_${v}_aarch64.app.tar.gz" update
    ;;
  x86_64-apple-darwin)
    take dmg "PR Quest_${v}_x64.dmg" "PR-Quest_${v}_x64.dmg"
    take_updatable macos "PR Quest.app.tar.gz" "PR-Quest_${v}_x64.app.tar.gz" update
    ;;
  x86_64-unknown-linux-gnu)
    take_updatable appimage "PR Quest_${v}_amd64.AppImage" "PR-Quest_${v}_amd64.AppImage" installer
    take deb "PR Quest_${v}_amd64.deb" "PR-Quest_${v}_amd64.deb"
    ;;
  aarch64-unknown-linux-gnu)
    take_updatable appimage "PR Quest_${v}_aarch64.AppImage" "PR-Quest_${v}_aarch64.AppImage" installer
    take deb "PR Quest_${v}_arm64.deb" "PR-Quest_${v}_arm64.deb"
    ;;
  x86_64-pc-windows-msvc)
    take_updatable nsis "PR Quest_${v}_x64-setup.exe" "PR-Quest_${v}_x64-setup.exe" installer
    ;;
  *) fail "PR Quest isn't released for $triple." ;;
esac
