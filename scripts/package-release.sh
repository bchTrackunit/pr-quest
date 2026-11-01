#!/usr/bin/env bash
# Builds the desktop installers for this machine into release/, signed when the signing secrets are
# in the environment and unsigned otherwise. The release workflow passes the secrets under the names
# below, which are electron-builder's except APPLE_API_KEY_P8, the key itself rather than a path to
# it. A secret that isn't set reaches this script as an empty string, so empty ones are unset first:
# electron-builder would treat them as set. See RELEASING.md.
set -euo pipefail

signing_vars=(
  CSC_LINK CSC_KEY_PASSWORD
  APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER
  APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
  AZURE_SIGNING_ENDPOINT AZURE_SIGNING_ACCOUNT AZURE_SIGNING_PROFILE AZURE_SIGNING_PUBLISHER
  AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET
  WIN_CSC_LINK WIN_CSC_KEY_PASSWORD
)
for name in "${signing_vars[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    unset "$name"
  fi
done

unsigned() {
  echo "::warning title=Unsigned build::$1"
}

fail() {
  echo "::error title=Signing settings::$1"
  exit 1
}

signed=false
case "$(uname -s)" in
  Darwin)
    if [[ -n "${CSC_LINK:-}" ]]; then
      if [[ -n "${APPLE_API_KEY_P8:-}" ]]; then
        if [[ -z "${APPLE_API_KEY_ID:-}" || -z "${APPLE_API_ISSUER:-}" ]]; then
          fail "APPLE_API_KEY_P8 is set, so APPLE_API_KEY_ID and APPLE_API_ISSUER must be too."
        fi
        key_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/notarize.XXXXXX")"
        export APPLE_API_KEY="$key_dir/AuthKey_$APPLE_API_KEY_ID.p8"
        (umask 077 && printf '%s\n' "$APPLE_API_KEY_P8" >"$APPLE_API_KEY")
        unset APPLE_API_KEY_P8
      elif [[ -z "${APPLE_ID:-}" || -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
        # A signed but unnotarized app is refused by Gatekeeper just like an unsigned one, and
        # electron-builder would only warn about it.
        fail "CSC_LINK is set but notarization isn't: set APPLE_API_KEY_P8, APPLE_API_KEY_ID and APPLE_API_ISSUER, or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID."
      fi
      signed=true
    else
      # Never fall back to whatever identity the machine's keychain holds.
      export CSC_IDENTITY_AUTO_DISCOVERY=false
      unset APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
      unsigned "No macOS signing certificate (CSC_LINK), so this build is unsigned and not notarized, and it can't update itself."
    fi
    ;;
  MINGW* | MSYS* | CYGWIN*)
    if [[ -n "${AZURE_SIGNING_ENDPOINT:-}" && -n "${WIN_CSC_LINK:-}" ]]; then
      fail "Set either the AZURE_SIGNING_* secrets or WIN_CSC_LINK, not both."
    elif [[ -n "${AZURE_SIGNING_ENDPOINT:-}" ]]; then
      if [[ -z "${AZURE_TENANT_ID:-}" || -z "${AZURE_CLIENT_ID:-}" || -z "${AZURE_CLIENT_SECRET:-}" ]]; then
        fail "AZURE_SIGNING_ENDPOINT is set, so AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET must be too."
      fi
      signed=true
    elif [[ -n "${WIN_CSC_LINK:-}" ]]; then
      signed=true
    else
      unsigned "No Windows signing settings (AZURE_SIGNING_* or WIN_CSC_LINK), so SmartScreen warns before the installer runs."
    fi
    ;;
  *) ;;
esac

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "signed=$signed" >>"$GITHUB_OUTPUT"
fi

yarn desktop:package "$@"
