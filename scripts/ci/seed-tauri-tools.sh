#!/usr/bin/env bash
# Puts pinned, checksummed copies of the tools Tauri's AppImage bundler downloads into its cache,
# so `tauri build` uses them instead of fetching its own. Tauri CLI 2.12.4 (tauri-bundler,
# crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs) downloads each one that isn't
# cached, without a checksum:
#
# - AppRun-<arch> from tauri-apps/binary-releases, tag apprun-old;
# - linuxdeploy-07333c6-<arch>.AppImage from tauri-apps/binary-releases, tag linuxdeploy-07333c6;
# - linuxdeploy-plugin-appimage.AppImage from linuxdeploy's "continuous" prerelease, which
#   changes whenever linuxdeploy pushes. Pinned here to its last tagged release instead.
#
# The appimagetool inside that plugin downloads the AppImage runtime, the program at the start of
# every AppImage, from AppImage/type2-runtime's "continuous" release, unless it is given one. This
# pins the runtime too, and exports LDAI_RUNTIME_FILE (to GITHUB_ENV in a workflow), which the
# plugin passes to appimagetool as --runtime-file. scripts/ci/package.sh refuses a Linux release
# build without it.
#
# The gtk and gstreamer plugin scripts are built into the CLI. Another CLI version may use other
# files, so this stops unless the installed CLI is the one these pins are for.
#
# Usage: scripts/ci/seed-tauri-tools.sh                      (from the repository root, on Linux)
#        scripts/ci/seed-tauri-tools.sh --check-runtime <file>  (is <file> the pinned runtime?)
set -euo pipefail

cli_version=2.12.4
runtime_release=20251108

fail() {
  echo "::error title=AppImage tools::$1"
  exit 1
}

# name, URL and SHA-256 of each tool, per processor; the runtime comes last.
arch="$(uname -m)"
case "$arch" in
  x86_64)
    tools=(
      AppRun-x86_64
      https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64
      f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f
      linuxdeploy-07333c6-x86_64.AppImage
      https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy-07333c6/linuxdeploy-x86_64.AppImage
      36a2d7e274d12e1050d0e9ecfe11d339ed54720b2bec464c286d53f8b07f5c62
      linuxdeploy-plugin-appimage.AppImage
      https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/1-alpha-20250213-1/linuxdeploy-plugin-appimage-x86_64.AppImage
      992d502a248e14ab185448ddf6f6e7d25558cb84d4623c354c3af350c25fccb3
      "appimage-runtime-$runtime_release-x86_64"
      "https://github.com/AppImage/type2-runtime/releases/download/$runtime_release/runtime-x86_64"
      2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d
    )
    ;;
  aarch64)
    tools=(
      AppRun-aarch64
      https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-aarch64
      072f17c0895a85c490282fe5395c5007e5fc75da727e553b3b8fb680feb11578
      linuxdeploy-07333c6-aarch64.AppImage
      https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy-07333c6/linuxdeploy-aarch64.AppImage
      556ab80baa98e600aa80f0dcedfb70bca0e1ce7e9f147fb345be3fcc3e91b2b1
      linuxdeploy-plugin-appimage.AppImage
      https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/1-alpha-20250213-1/linuxdeploy-plugin-appimage-aarch64.AppImage
      83c292149274965a865dcd44c135cfca8ba28c6b7de3eb628d4b8b5f248af17c
      "appimage-runtime-$runtime_release-aarch64"
      "https://github.com/AppImage/type2-runtime/releases/download/$runtime_release/runtime-aarch64"
      00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444
    )
    ;;
  *) fail "No pinned AppImage tools for $arch." ;;
esac
runtime_sha256="${tools[${#tools[@]} - 1]}"

sha256() {
  sha256sum "$1" | cut -d ' ' -f 1
}

if [[ "${1:-}" == --check-runtime ]]; then
  file="${2:?usage: $0 --check-runtime <file>}"
  [[ -f "$file" ]] || fail "$file isn't a file."
  actual="$(sha256 "$file")"
  [[ "$actual" == "$runtime_sha256" ]] ||
    fail "$file has SHA-256 $actual, not the pinned $arch runtime's $runtime_sha256."
  exit 0
elif [[ -n "${1:-}" ]]; then
  echo "usage: $0 [--check-runtime <file>]" >&2
  exit 2
fi

installed="$(jq -r .version node_modules/@tauri-apps/cli/package.json 2>/dev/null)" ||
  fail "Install the dependencies first; no node_modules/@tauri-apps/cli."
if [[ "$installed" != "$cli_version" ]]; then
  fail "The pins in $0 are for Tauri CLI $cli_version, but $installed is installed. Check what its AppImage bundler downloads and update them."
fi
# With it, the bundler keeps its tools in the target folder instead of the cache seeded here.
if [[ "$(jq -r '.bundle.useLocalToolsDir // false' src-tauri/tauri.conf.json)" != false ]]; then
  fail "src-tauri/tauri.conf.json sets bundle.useLocalToolsDir, so the bundler wouldn't use the pinned tools."
fi

# Where the bundler looks: dirs::cache_dir() joined with "tauri".
cache="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
mkdir -p "$cache"
for ((i = 0; i < ${#tools[@]}; i += 3)); do
  name="${tools[$i]}" url="${tools[$((i + 1))]}" sha256="${tools[$((i + 2))]}"
  # Always fresh: the bundler overwrites three bytes of linuxdeploy's header with zeros on every
  # run, before it starts it, so a copy from an earlier run no longer matches its checksum, and a
  # cached file is exactly what the checksum is meant not to trust.
  rm -f "$cache/$name"
  curl --fail --location --silent --show-error --retry 3 --output "$cache/$name.part" "$url"
  actual="$(sha256 "$cache/$name.part")"
  if [[ "$actual" != "$sha256" ]]; then
    rm -f "$cache/$name.part"
    fail "$url has SHA-256 $actual, not the pinned $sha256."
  fi
  chmod 755 "$cache/$name.part"
  mv "$cache/$name.part" "$cache/$name"
  echo "$name: $sha256"
done

runtime="$cache/${tools[${#tools[@]} - 3]}"
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "LDAI_RUNTIME_FILE=$runtime" >>"$GITHUB_ENV"
fi
echo "LDAI_RUNTIME_FILE=$runtime"
