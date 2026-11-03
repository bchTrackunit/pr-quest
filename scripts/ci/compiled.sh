#!/usr/bin/env bash
# Carries what the release workflow's compile job built to its bundle job, which bundles and signs
# it in a fresh checkout: the shell binary, the sidecar's server bundle (main.mjs) and its UI
# (dist/). Nothing else crosses: the bundle job lays out the sidecar's packages and Node from its
# own install and downloads (apps/desktop/scripts/desktop/layout.ts), and runs its own tools.
#
#   scripts/ci/compiled.sh pack <triple> <folder>
#     After `package.sh --compile-only`: writes <folder>/compiled.tar and <folder>/MANIFEST.sha256,
#     the SHA-256 of each file in it. The tar keeps the binary executable, which an artifact's zip
#     wouldn't.
#   scripts/ci/compiled.sh unpack <triple> <folder>
#     In a fresh checkout: checks that the tar holds only files and folders under the names above,
#     that they are exactly the manifest's, with its SHA-256s, and puts them where `package.sh
#     --skip-compile` looks. Stops if anything is there already.
#   scripts/ci/compiled.sh check-unbuilt <triple> <folder>
#     After bundling: stops if cargo or `yarn build` ran, or if main.mjs or dist/ changed.
#
# Run from the repository root; <folder> is relative to it. The bundles' target folder is
# $CARGO_TARGET_DIR, by default apps/desktop/src-tauri/target.
set -euo pipefail

usage="usage: $0 pack|unpack|check-unbuilt <triple> <folder>"
mode="${1:?$usage}"
triple="${2:?$usage}"
folder="${3:?$usage}"

fail() {
  echo "::error title=Compiled shell::$1"
  exit 1
}

[[ "$triple" =~ ^[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+(-[a-z0-9_]+)?$ ]] || fail "$triple isn't a target triple."
binary=pr-quest
if [[ "$triple" == *-windows-* ]]; then
  binary=pr-quest.exe
fi
release="${CARGO_TARGET_DIR:-apps/desktop/src-tauri/target}/$triple/release"
sidecar=apps/desktop/build-tauri/sidecar

if command -v sha256sum >/dev/null; then
  checksum=(sha256sum)
else
  checksum=(shasum -a 256)
fi

# The manifest of the files in folder $1, by their paths relative to it, sorted.
manifest() {
  (cd "$1" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r file; do
    "${checksum[@]}" -- "$file"
  done) | sed 's/ \*/  /'
}

# Manifest $1, sorted like manifest's.
sorted() {
  LC_ALL=C sort -k 2 "$1"
}

# Names in the tar: the binary, and main.mjs and dist/ of the sidecar. Plain names only, so no
# entry can point outside the folder it is unpacked into.
allowed() {
  [[ "$1" =~ ^[A-Za-z0-9._@+-]+(/[A-Za-z0-9._@+-]+)*/?$ && "/$1/" != */../* && "/$1/" != */./* ]] || return 1
  case "$1" in
    "$binary" | sidecar/ | sidecar/main.mjs | sidecar/dist/ | sidecar/dist/*) return 0 ;;
  esac
  return 1
}

case "$mode" in
  pack)
    [[ -f "$release/$binary" ]] || fail "No $release/$binary; run package.sh --compile-only first."
    for built in main.mjs dist/index.html; do
      [[ -f "$sidecar/$built" ]] || fail "No $sidecar/$built; run package.sh --compile-only first."
    done
    mkdir -p "$folder"
    [[ -z "$(ls -A "$folder")" ]] || fail "$folder isn't empty."
    staging="$(mktemp -d)"
    trap 'rm -rf "$staging"' EXIT
    cp "$release/$binary" "$staging/$binary"
    mkdir "$staging/sidecar"
    cp "$sidecar/main.mjs" "$staging/sidecar/main.mjs"
    cp -R "$sidecar/dist" "$staging/sidecar/dist"
    manifest "$staging" >"$folder/MANIFEST.sha256"
    # Through stdin and stdout: GNU tar reads a Windows path with a drive letter as a remote host.
    (cd "$staging" && tar -cf - "$binary" sidecar) >"$folder/compiled.tar"
    echo "Packed $(wc -l <"$folder/MANIFEST.sha256" | tr -d ' ') files for $triple."
    ;;

  unpack)
    [[ -f "$folder/compiled.tar" && -f "$folder/MANIFEST.sha256" ]] ||
      fail "$folder has no compiled.tar and MANIFEST.sha256."
    [[ ! -e "$release" ]] || fail "$release exists already; unpack into a fresh checkout."
    [[ ! -e "$sidecar" ]] || fail "$sidecar exists already; unpack into a fresh checkout."
    # set -e misses failures inside a pipeline's loop, so each list is checked as a whole.
    names="$(tar -tf - <"$folder/compiled.tar")" || fail "compiled.tar isn't a tar."
    types="$(tar -tvf - <"$folder/compiled.tar" | cut -c1 | LC_ALL=C sort -u | tr -d '\n')" ||
      fail "compiled.tar isn't a tar."
    [[ "$types" =~ ^[-d]+$ ]] || fail "compiled.tar holds entries other than files and folders: $types."
    while IFS= read -r name; do
      allowed "$name" || fail "compiled.tar holds $name, which isn't the shell or its built sidecar."
    done <<<"$names"
    staging="$(mktemp -d)"
    trap 'rm -rf "$staging"' EXIT
    (cd "$staging" && tar -xf -) <"$folder/compiled.tar"
    [[ "$(manifest "$staging")" == "$(sorted "$folder/MANIFEST.sha256")" ]] ||
      fail "compiled.tar doesn't match MANIFEST.sha256."
    [[ -f "$staging/$binary" && -f "$staging/sidecar/main.mjs" && -f "$staging/sidecar/dist/index.html" ]] ||
      fail "compiled.tar lacks the shell, main.mjs or dist/index.html."
    mkdir -p "$release" "$(dirname "$sidecar")"
    cp "$staging/$binary" "$release/$binary"
    chmod 755 "$release/$binary"
    cp -R "$staging/sidecar" "$sidecar"
    echo "Unpacked the shell and the built sidecar for $triple, $(wc -l <"$folder/MANIFEST.sha256" | tr -d ' ') files."
    ;;

  check-unbuilt)
    [[ -f "$folder/MANIFEST.sha256" ]] || fail "No $folder/MANIFEST.sha256."
    for made in .cargo-lock .fingerprint build deps incremental; do
      [[ ! -e "$release/$made" ]] || fail "$release/$made exists: cargo built something in the bundle job."
    done
    for dist in apps/web/dist apps/server/dist; do
      [[ ! -e "$dist" ]] || fail "$dist exists: yarn build ran in the bundle job."
    done
    staging="$(mktemp -d)"
    trap 'rm -rf "$staging"' EXIT
    mkdir "$staging/sidecar"
    cp "$sidecar/main.mjs" "$staging/sidecar/main.mjs"
    cp -R "$sidecar/dist" "$staging/sidecar/dist"
    [[ "$(manifest "$staging")" == "$(sorted "$folder/MANIFEST.sha256" | grep -vF "  $binary")" ]] ||
      fail "main.mjs or dist/ changed in the bundle job; something rebuilt the sidecar."
    echo "Bundled $triple without compiling: no cargo output, no yarn build, the built sidecar unchanged."
    ;;

  *)
    echo "$usage" >&2
    exit 2
    ;;
esac
