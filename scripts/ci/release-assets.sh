#!/usr/bin/env bash
# Turns what the release build jobs uploaded, one folder per job (scripts/ci/collect-bundles.sh),
# into the release's assets, and stops at anything it doesn't expect:
#
# 1. Gathers the files into <output folder>. A name two jobs produced stops it.
# 2. Checks that they are exactly the installers and update files of every platform, and that
#    every target's build record (build-<triple>.txt, from scripts/ci/package.sh) says its macOS
#    or Windows bundles were signed and not built with the dry run's opt-out. With --dry-run it
#    accepts unsigned bundles, and leaves a DRY-RUN file in <output folder>, which the publish job
#    refuses.
# 3. Checks every update file's .sig against PR_QUEST_UPDATER_PUBKEY, the key the apps were built
#    with, with `just desktop-verify-updater`, and that the signature is bound to <version>, as
#    the app requires (requireSignedVersion).
# 4. Writes latest.json, the manifest the app's updater reads, and SHA256SUMS.txt.
#
# Usage: scripts/ci/release-assets.sh <downloaded artifacts> <output folder> <version> <download url> [--dry-run]
# where <download url> is https://github.com/<owner>/<repo>/releases/download/<tag>. Needs jq.
set -euo pipefail

usage="usage: $0 <downloaded artifacts> <output folder> <version> <download url> [--dry-run]"
in="${1:?$usage}"
out="${2:?$usage}"
version="${3:?$usage}"
download="${4:?$usage}"
dry_run=false
if [[ "${5:-}" == --dry-run ]]; then
  dry_run=true
elif [[ -n "${5:-}" ]]; then
  echo "$usage" >&2
  exit 2
fi

fail() {
  echo "::error title=Release assets::$1"
  exit 1
}

[[ -n "${PR_QUEST_UPDATER_PUBKEY:-}" ]] ||
  fail "PR_QUEST_UPDATER_PUBKEY isn't set, so the update signatures can't be checked against the key the apps trust."
[[ "$download" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/v[^/]+$ ]] ||
  fail "$download isn't a GitHub release download URL."
[[ "$version" =~ ^[0-9A-Za-z.+-]+$ ]] || fail "$version isn't a version."

# The update file of each platform key of latest.json. The .deb has none: the package manager
# updates it, and the app never updates itself from one.
platforms=(darwin-aarch64 darwin-x86_64 linux-x86_64 linux-aarch64 windows-x86_64)
update_file() {
  case "$1" in
    darwin-aarch64) echo "PR-Quest_${version}_aarch64.app.tar.gz" ;;
    darwin-x86_64) echo "PR-Quest_${version}_x64.app.tar.gz" ;;
    linux-x86_64) echo "PR-Quest_${version}_amd64.AppImage" ;;
    linux-aarch64) echo "PR-Quest_${version}_aarch64.AppImage" ;;
    windows-x86_64) echo "PR-Quest_${version}_x64-setup.exe" ;;
  esac
}
expected=(
  "PR-Quest_${version}_aarch64.dmg"
  "PR-Quest_${version}_x64.dmg"
  "PR-Quest_${version}_amd64.deb"
  "PR-Quest_${version}_arm64.deb"
)
for platform in "${platforms[@]}"; do
  expected+=("$(update_file "$platform")" "$(update_file "$platform").sig")
done

triples=(
  aarch64-apple-darwin x86_64-apple-darwin x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu
  x86_64-pc-windows-msvc
)

is_expected() {
  local name
  for name in "${expected[@]}"; do
    if [[ "$name" == "$1" ]]; then
      return 0
    fi
  done
  return 1
}

is_record() {
  local triple
  for triple in "${triples[@]}"; do
    if [[ "build-$triple.txt" == "$1" ]]; then
      return 0
    fi
  done
  return 1
}

mkdir -p "$out"
[[ -z "$(ls -A "$out")" ]] || fail "$out isn't empty."
records="$(mktemp -d)"
trap 'rm -rf "$records"' EXIT
shopt -s nullglob
for file in "$in"/*/*; do
  name="$(basename "$file")"
  [[ -f "$file" ]] || fail "$file isn't a file."
  if is_record "$name"; then
    [[ ! -e "$records/$name" ]] || fail "More than one build job produced $name."
    cp "$file" "$records/$name"
    continue
  fi
  is_expected "$name" || fail "$name isn't a release asset; a build job made something unexpected."
  [[ ! -e "$out/$name" ]] || fail "More than one build job produced $name."
  cp "$file" "$out/$name"
done
for name in "${expected[@]}"; do
  [[ -f "$out/$name" ]] || fail "No build job produced $name."
done
echo "Gathered the ${#expected[@]} installers and update files."

# The build records say how each target's bundles were signed. Only the dry run accepts unsigned
# macOS and Windows bundles, or ones built with its opt-out, PR_QUEST_ALLOW_UNSIGNED_RELEASE.
field() {
  sed -n "s/^$1=//p" "$2"
}
for triple in "${triples[@]}"; do
  record="$records/build-$triple.txt"
  [[ -f "$record" ]] || fail "No build job produced build-$triple.txt, the record of how it was signed."
  [[ "$(field target "$record")" == "$triple" ]] || fail "build-$triple.txt is the record of another target."
  signed="$(field signed "$record")"
  unsigned_release="$(field unsigned_release "$record")"
  [[ "$signed" =~ ^(true|false)$ && "$unsigned_release" =~ ^(true|false)$ ]] ||
    fail "build-$triple.txt isn't a build record."
  if [[ "$dry_run" == false ]]; then
    [[ "$unsigned_release" == false ]] ||
      fail "$triple was built with PR_QUEST_ALLOW_UNSIGNED_RELEASE, which only a dry run may use."
    if [[ "$triple" == *-apple-darwin || "$triple" == *-windows-* ]]; then
      [[ "$signed" == true ]] || fail "$triple wasn't code signed, which a release must be."
    fi
  fi
  echo "$triple: signed=$signed, unsigned_release=$unsigned_release"
done

# The trusted comment of a .sig, which its global signature covers: timestamp:…	file:…	version:…
trusted_comment() {
  base64 --decode <"$1" | sed -n 's/^trusted comment: //p'
}

manifest="$(jq -n --arg version "$version" --arg notes "PR Quest $version" \
  --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{version: $version, notes: $notes, pub_date: $date, platforms: {}}')"
for platform in "${platforms[@]}"; do
  name="$(update_file "$platform")"
  just desktop-verify-updater "$out/$name" ||
    fail "$name.sig isn't a valid signature by the updater key in PR_QUEST_UPDATER_PUBKEY."
  comment="$(trusted_comment "$out/$name.sig")" || fail "Can't read the trusted comment of $name.sig."
  bound=""
  IFS=$'\t' read -r -a fields <<<"$comment"
  for field in ${fields[@]+"${fields[@]}"}; do
    if [[ "$field" == version:* ]]; then
      bound="${field#version:}"
    fi
  done
  [[ "$bound" == "$version" ]] ||
    fail "$name.sig is bound to version \"$bound\", not $version, so the app would refuse the update."
  manifest="$(jq --arg platform "$platform" --arg url "$download/$name" \
    --rawfile signature "$out/$name.sig" \
    '.platforms[$platform] = {signature: ($signature | sub("\\s+$"; "")), url: $url}' <<<"$manifest")" ||
    fail "Can't add $platform to latest.json."
done
printf '%s\n' "$manifest" >"$out/latest.json"

# set -e misses failures inside [[ ]], so the result is checked as a whole.
listed="$(jq -r '.platforms | keys | sort | join(" ")' "$out/latest.json")" ||
  fail "Can't read latest.json."
want="$(printf '%s\n' "${platforms[@]}" | sort | tr '\n' ' ' | sed 's/ $//')"
[[ "$listed" == "$want" ]] || fail "latest.json lists \"$listed\", not \"$want\"."
for platform in "${platforms[@]}"; do
  name="$(update_file "$platform")"
  signature="$(jq -r --arg platform "$platform" '.platforms[$platform].signature' "$out/latest.json")"
  [[ "$signature" == "$(tr -d '[:space:]' <"$out/$name.sig")" ]] ||
    fail "latest.json's $platform signature isn't the one in $name.sig."
done
echo "Wrote latest.json for ${platforms[*]}:"
jq -r '.platforms | to_entries[] | "  \(.key): \(.value.url)"' "$out/latest.json"

if command -v sha256sum >/dev/null; then
  checksum=(sha256sum)
else
  checksum=(shasum -a 256)
fi
sums="$(cd "$out" && "${checksum[@]}" -- *)" || fail "Can't checksum the assets."
printf '%s\n' "$sums" >"$out/SHA256SUMS.txt"
echo "Wrote SHA256SUMS.txt."
if [[ "$dry_run" == true ]]; then
  echo "A dry run's files, which may be unsigned; never publish them." >"$out/DRY-RUN"
fi
