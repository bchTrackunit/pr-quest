#!/usr/bin/env bash
# Gathers what the release build jobs uploaded, one folder per job, into one folder of release
# assets. Each macOS job writes a latest-mac.yml (or beta-mac.yml, and so on) that names only its
# own zip and dmg, while electron-updater reads a single one per release and picks the arm64 or x64
# file from its list, so those are merged. Any other name that two jobs produced is an error,
# because one upload would replace the other. Needs yq (https://github.com/mikefarah/yq) v4.
# Usage: scripts/collect-release-assets.sh <downloaded artifacts> <output folder>
set -euo pipefail

in="${1:?usage: $0 <downloaded artifacts> <output folder>}"
out="${2:?usage: $0 <downloaded artifacts> <output folder>}"

fail() {
  echo "::error title=Release assets::$1"
  exit 1
}

command -v yq >/dev/null || fail "yq is needed to merge the macOS update files."
mkdir -p "$out"
shopt -s nullglob

for file in "$in"/*/*; do
  name="$(basename "$file")"
  if [[ "$name" == *-mac.yml ]]; then
    continue
  fi
  if [[ -e "$out/$name" ]]; then
    fail "More than one build job produced $name."
  fi
  cp "$file" "$out/$name"
done

for name in $(find "$in" -mindepth 2 -maxdepth 2 -name '*-mac.yml' -exec basename {} \; | sort -u); do
  sources=("$in"/*/"$name")
  versions="$(yq ea '[.version] | unique | length' "${sources[@]}" | tail -n 1)"
  if [[ "$versions" != 1 ]]; then
    fail "The $name files disagree on the version."
  fi
  # The top-level path and sha512 are only for old electron-updater versions; keep the x64 ones,
  # the file those versions would pick.
  # shellcheck disable=SC2016 # $doc and $docs are yq variables
  yq ea '
    . as $doc ireduce ([]; . + [$doc])
    | . as $docs
    | ([$docs[] | select(.path | test("arm64") | not)] + $docs) | .[0]
    | .files = [$docs[].files[]]
    | .releaseDate = ([$docs[].releaseDate] | sort | .[-1])
  ' "${sources[@]}" >"$out/$name"
  if [[ "$(yq '[.files[].url] | length == (unique | length)' "$out/$name")" != true ]]; then
    fail "The $name files name the same installer more than once."
  fi
  echo "Merged $name from ${#sources[@]} build jobs: $(yq -o=json -I=0 '[.files[].url]' "$out/$name")"
done
