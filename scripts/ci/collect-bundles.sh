#!/usr/bin/env bash
# Copies what `just desktop-package --target <triple>` made into one folder, under the names the
# release publishes them as: no spaces, which GitHub would turn into dots, and each macOS update
# file named after its processor. With --updater, as for a release build, it adds the update
# files, still unsigned (the release workflow's sign-updates job signs them), and the build record
# scripts/ci/package.sh wrote, as build-<triple>.txt. Anything missing stops it.
#
# The macOS update file is made here from the finished app, notarization ticket included: a
# gzipped tar with "PR Quest.app" at its root, as Tauri's bundler makes it and tauri-plugin-updater
# unpacks it (it drops the first part of every path). Symbolic links stay links, and no extended
# attributes or AppleDouble files go in.
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

# The macOS update file, $1, made from the app.
mac_update() {
  local app="$bundle/macos/PR Quest.app"
  local -a flags
  if [[ ! -d "$app" ]]; then
    fail "$triple has no macos/PR Quest.app to make the update file from."
  fi
  if [[ -e "$out/$1" ]]; then
    fail "$out/$1 exists already."
  fi
  if tar --version 2>/dev/null | grep -q bsdtar; then
    flags=(--format gnutar --no-mac-metadata --no-xattrs --no-acls --no-fflags)
  else
    flags=(--format=gnu --no-xattrs --no-acls --no-selinux)
  fi
  COPYFILE_DISABLE=1 tar --create --gzip "${flags[@]}" --file "$out/$1" \
    --directory "$bundle/macos" "PR Quest.app"
  echo "macos/PR Quest.app -> $1"
}

mkdir -p "$out"
v="$version"
case "$triple" in
  aarch64-apple-darwin)
    take dmg "PR Quest_${v}_aarch64.dmg" "PR-Quest_${v}_aarch64.dmg"
    if [[ "$updater" == true ]]; then
      mac_update "PR-Quest_${v}_aarch64.app.tar.gz"
    fi
    ;;
  x86_64-apple-darwin)
    take dmg "PR Quest_${v}_x64.dmg" "PR-Quest_${v}_x64.dmg"
    if [[ "$updater" == true ]]; then
      mac_update "PR-Quest_${v}_x64.app.tar.gz"
    fi
    ;;
  x86_64-unknown-linux-gnu)
    take appimage "PR Quest_${v}_amd64.AppImage" "PR-Quest_${v}_amd64.AppImage"
    take deb "PR Quest_${v}_amd64.deb" "PR-Quest_${v}_amd64.deb"
    ;;
  aarch64-unknown-linux-gnu)
    take appimage "PR Quest_${v}_aarch64.AppImage" "PR-Quest_${v}_aarch64.AppImage"
    take deb "PR Quest_${v}_arm64.deb" "PR-Quest_${v}_arm64.deb"
    ;;
  x86_64-pc-windows-msvc)
    take nsis "PR Quest_${v}_x64-setup.exe" "PR-Quest_${v}_x64-setup.exe"
    ;;
  *) fail "PR Quest isn't released for $triple." ;;
esac
if [[ "$updater" == true ]]; then
  take . pr-quest-build.txt "build-$triple.txt"
fi
