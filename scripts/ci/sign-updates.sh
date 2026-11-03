#!/usr/bin/env bash
# Signs the release's five update files with the updater's private key, in the release workflow's
# sign-updates job: the only job that gets the key, and it builds nothing. Every installed app
# accepts an update signed with this key, so nothing from yarn or cargo runs next to it.
#
# 1. Installs the Tauri CLI's signer and minisign from pinned release files, checked against
#    pinned SHA-256s.
# 2. Signs and verifies a probe first, so a key that doesn't match PR_QUEST_UPDATER_PUBKEY, or a
#    wrong password, stops it before anything is signed.
# 3. Signs each update file found once in <downloaded artifacts>/*/ with `tauri signer sign
#    --app-version <version>`, as `tauri build` does: the trusted comment ends in
#    "version:<version>", which the app requires (requireSignedVersion). Then verifies the
#    signature with minisign against PR_QUEST_UPDATER_PUBKEY and checks that version.
# 4. Writes only the five .sig files to <output folder>.
#
# Usage: scripts/ci/sign-updates.sh <downloaded artifacts> <output folder> <version>
# with TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD (empty for a key without
# one) and PR_QUEST_UPDATER_PUBKEY in the environment. Runs on Linux x64 and Apple silicon Macs.
set -euo pipefail

usage="usage: $0 <downloaded artifacts> <output folder> <version>"
in="${1:?$usage}"
out="${2:?$usage}"
version="${3:?$usage}"

fail() {
  echo "::error title=Update signatures::$1"
  exit 1
}

[[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]] ||
  fail "TAURI_SIGNING_PRIVATE_KEY isn't set; it is a secret of the release environment."
[[ -n "${PR_QUEST_UPDATER_PUBKEY:-}" ]] ||
  fail "PR_QUEST_UPDATER_PUBKEY isn't set, so the signatures can't be checked against the key the apps trust."
[[ "$version" =~ ^[0-9A-Za-z.+-]+$ ]] || fail "$version isn't a version."
# The signer reads the key from the environment, and only one of these may be set.
unset TAURI_SIGNING_PRIVATE_KEY_PATH
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# The public key is the base64 of minisign's .pub file; minisign takes its second line.
pubkey="$(printf '%s' "$PR_QUEST_UPDATER_PUBKEY" | base64 --decode 2>/dev/null | sed -n 2p)" || pubkey=""
[[ "$pubkey" =~ ^[A-Za-z0-9+/]{54}[A-Za-z0-9+/=]{2}$ ]] ||
  fail "PR_QUEST_UPDATER_PUBKEY isn't a Tauri updater public key."

names=(
  "PR-Quest_${version}_aarch64.app.tar.gz"
  "PR-Quest_${version}_x64.app.tar.gz"
  "PR-Quest_${version}_amd64.AppImage"
  "PR-Quest_${version}_aarch64.AppImage"
  "PR-Quest_${version}_x64-setup.exe"
)

mkdir -p "$out"
[[ -z "$(ls -A "$out")" ]] || fail "$out isn't empty."
tools="$(mktemp -d)"
trap 'rm -rf "$tools"' EXIT

if command -v sha256sum >/dev/null; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
else
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
fi

# Downloads $1 to $tools/$3 and checks it against $2.
fetch() {
  curl --fail --location --silent --show-error --retry 3 --output "$tools/$3" "$1"
  local actual
  actual="$(sha256 "$tools/$3")"
  [[ "$actual" == "$2" ]] || fail "$1 has SHA-256 $actual, not the pinned $2."
}

# The Tauri CLI's own release (tauri-apps/tauri, tag tauri-cli-v2.12.4), the version
# package.json pins, and minisign 0.12 (jedisct1/minisign), whose files are minisign-signed by
# their author; the SHA-256s are of files whose signatures checked out.
tauri_release=https://github.com/tauri-apps/tauri/releases/download/tauri-cli-v2.12.4
minisign_release=https://github.com/jedisct1/minisign/releases/download/0.12
# SIGN_UPDATES_TOOLS, a folder with stand-ins for both, is for this script's tests only.
bin="${SIGN_UPDATES_TOOLS:-$tools}"
if [[ -z "${SIGN_UPDATES_TOOLS:-}" ]]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)
      fetch "$tauri_release/cargo-tauri-x86_64-unknown-linux-gnu.tgz" \
        820ae3c7580ca637cad15f65638960ee2a96e5a491e224691c86d6f25e6c9e8a tauri.tgz
      tar -xzf "$tools/tauri.tgz" -C "$tools" cargo-tauri
      fetch "$minisign_release/minisign-0.12-linux.tar.gz" \
        9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73 minisign.tgz
      tar -xzf "$tools/minisign.tgz" -C "$tools" --strip-components 2 minisign-linux/x86_64/minisign
      ;;
    Darwin-arm64)
      fetch "$tauri_release/cargo-tauri-aarch64-apple-darwin.zip" \
        f71a34ada728ca2d1a51c28d6d21639e1e080898ec69ec8d49c5da3b7e8bc1be tauri.zip
      unzip -q "$tools/tauri.zip" cargo-tauri -d "$tools"
      fetch "$minisign_release/minisign-0.12-macos.zip" \
        89000b19535765f9cffc65a65d64a820f433ef6db8020667f7570e06bf6aac63 minisign.zip
      unzip -q "$tools/minisign.zip" minisign -d "$tools"
      ;;
    *) fail "No pinned signer for $(uname -s) $(uname -m)." ;;
  esac
  chmod 755 "$tools/cargo-tauri" "$tools/minisign"
fi

# Signs $1, then verifies the signature; returns non-zero if either fails or the signature
# isn't bound to the version.
sign_and_verify() {
  local file="$1" comment bound="" field
  rm -f "$file.sig"
  "$bin/cargo-tauri" signer sign --app-version "$version" "$file" >/dev/null || return 1
  base64 --decode <"$file.sig" >"$tools/signature" || return 1
  comment="$("$bin/minisign" -V -Q -P "$pubkey" -m "$file" -x "$tools/signature")" || return 1
  IFS=$'\t' read -r -a fields <<<"$comment"
  for field in ${fields[@]+"${fields[@]}"}; do
    if [[ "$field" == version:* ]]; then
      bound="${field#version:}"
    fi
  done
  [[ "$bound" == "$version" ]]
}

printf 'PR Quest %s update signing probe\n' "$version" >"$tools/probe"
sign_and_verify "$tools/probe" ||
  fail "TAURI_SIGNING_PRIVATE_KEY, with TAURI_SIGNING_PRIVATE_KEY_PASSWORD, doesn't make signatures that PR_QUEST_UPDATER_PUBKEY verifies: the key pair doesn't match, or the password is wrong."
echo "The updater key matches PR_QUEST_UPDATER_PUBKEY."

shopt -s nullglob
for name in "${names[@]}"; do
  found=("$in"/*/"$name")
  [[ "${#found[@]}" == 1 && -f "${found[0]}" ]] ||
    fail "Expected one $name among the build jobs' files, found ${#found[@]}."
  sign_and_verify "${found[0]}" || fail "Signing $name failed, or its signature doesn't verify."
  mv "${found[0]}.sig" "$out/$name.sig"
  echo "Signed $name for version $version."
done
