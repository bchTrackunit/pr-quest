#!/usr/bin/env bash
# Builds the desktop installers for this machine into release/, signed when the signing secrets are
# in the environment and unsigned when none are. The release workflow passes the secrets under the
# names below, which are electron-builder's except APPLE_API_KEY_P8, the key itself rather than a
# path to it. A secret that isn't set reaches this script as an empty string, so empty ones are
# unset first: electron-builder would treat them as set.
#
# A platform with only some of its secrets set stops the build, whichever ones are missing, and so
# does an unsigned macOS or Windows build when REQUIRE_SIGNING is true: once users run a signed
# version, an unsigned one can't update it. See RELEASING.md.
set -euo pipefail

mac_certificate=(CSC_LINK CSC_KEY_PASSWORD)
mac_api_key=(APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER)
mac_account=(APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID)
win_azure=(
  AZURE_SIGNING_ENDPOINT AZURE_SIGNING_ACCOUNT AZURE_SIGNING_PROFILE AZURE_SIGNING_PUBLISHER
  AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET
)
win_pfx=(WIN_CSC_LINK WIN_CSC_KEY_PASSWORD)

for name in "${mac_certificate[@]}" "${mac_api_key[@]}" "${mac_account[@]}" "${win_azure[@]}" "${win_pfx[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    unset "$name"
  fi
done

fail() {
  echo "::error title=Signing settings::$1"
  exit 1
}

any_set() {
  local name
  for name in "$@"; do
    if [[ -n "${!name:-}" ]]; then
      return 0
    fi
  done
  return 1
}

# Stops unless every named secret is set; $1 says what they're for.
require_all() {
  local purpose="$1" name missing=""
  shift
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      missing="${missing:+$missing, }$name"
    fi
  done
  if [[ -n "$missing" ]]; then
    fail "Some of the secrets for $purpose are set, but not $missing. Set all of them, or none of this platform's for an unsigned build."
  fi
}

unsigned() {
  if [[ "${REQUIRE_SIGNING:-}" == true ]]; then
    fail "$1 REQUIRE_SIGNING is true, so the build stops instead of shipping it unsigned."
  fi
  echo "::warning title=Unsigned build::$1"
}

signed=false
case "$(uname -s)" in
  Darwin)
    if any_set "${mac_certificate[@]}" "${mac_api_key[@]}" "${mac_account[@]}"; then
      require_all "macOS signing" "${mac_certificate[@]}"
      if any_set "${mac_api_key[@]}" && any_set "${mac_account[@]}"; then
        fail "Notarize with the App Store Connect API key (APPLE_API_KEY_*) or with an Apple Account (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID), not both."
      elif any_set "${mac_api_key[@]}"; then
        require_all "notarizing with the API key" "${mac_api_key[@]}"
        key_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/notarize.XXXXXX")"
        trap 'rm -rf "$key_dir"' EXIT
        export APPLE_API_KEY="$key_dir/AuthKey_$APPLE_API_KEY_ID.p8"
        (umask 077 && printf '%s\n' "$APPLE_API_KEY_P8" >"$APPLE_API_KEY")
        unset APPLE_API_KEY_P8
      elif any_set "${mac_account[@]}"; then
        require_all "notarizing with an Apple Account" "${mac_account[@]}"
      else
        # A signed but unnotarized app is refused by Gatekeeper just like an unsigned one, and
        # electron-builder would only warn about it.
        fail "The macOS certificate is set but notarization isn't: set APPLE_API_KEY_P8, APPLE_API_KEY_ID and APPLE_API_ISSUER, or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID."
      fi
      signed=true
    else
      # Never fall back to whatever identity the machine's keychain holds.
      export CSC_IDENTITY_AUTO_DISCOVERY=false
      unsigned "No macOS signing secrets, so this build is unsigned and not notarized, and it can't update itself."
    fi
    ;;
  MINGW* | MSYS* | CYGWIN*)
    if any_set "${win_azure[@]}" && any_set "${win_pfx[@]}"; then
      fail "Sign with Trusted Signing (AZURE_*) or with a certificate file (WIN_CSC_*), not both."
    elif any_set "${win_azure[@]}"; then
      require_all "Trusted Signing" "${win_azure[@]}"
      signed=true
    elif any_set "${win_pfx[@]}"; then
      require_all "signing with a certificate file" "${win_pfx[@]}"
      signed=true
    else
      unsigned "No Windows signing secrets, so SmartScreen warns before the installer runs."
    fi
    ;;
  *) ;;
esac

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "signed=$signed" >>"$GITHUB_OUTPUT"
fi

yarn desktop:package "$@"
