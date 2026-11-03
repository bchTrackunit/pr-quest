#!/usr/bin/env bash
# Packages the desktop app for this machine with `just desktop-package --target <triple> ...`,
# signed when the signing secrets are in the environment. The release workflow passes them under
# the names below; see RELEASING.md. A secret that isn't set reaches this script as an empty
# string, so empty ones are unset first.
#
# - Release builds (PR_QUEST_RELEASE_BUILD=1) need the updater key pair on every platform:
#   PR_QUEST_UPDATER_PUBKEY and TAURI_SIGNING_PRIVATE_KEY (or, for a dry run, the files
#   UPDATER_PUBKEY_FILE and UPDATER_PRIVATE_KEY_FILE).
# - macOS: APPLE_CERTIFICATE (a base64 .p12) and APPLE_CERTIFICATE_PASSWORD are imported into a
#   temporary keychain, which sets APPLE_SIGNING_IDENTITY; notarization takes APPLE_API_ISSUER,
#   APPLE_API_KEY_ID and APPLE_API_KEY_P8 (the .p8 file's contents), or APPLE_ID, APPLE_PASSWORD
#   and APPLE_TEAM_ID.
# - Windows: Azure Artifact Signing (formerly Trusted Signing) through signtool and Microsoft's
#   dlib with AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SIGNING_ENDPOINT,
#   AZURE_SIGNING_ACCOUNT and AZURE_SIGNING_PROFILE, or a certificate file: WINDOWS_PFX (a base64
#   .pfx) and WINDOWS_PFX_PASSWORD. Either sets PR_QUEST_WINDOWS_SIGN_COMMAND.
#
# A platform with only some of its secrets set stops the build, and so does a macOS or Windows
# release build without any, unless PR_QUEST_ALLOW_UNSIGNED_RELEASE is 1: the dry run's opt-out,
# which a tag build (GITHUB_EVENT_NAME=push) refuses. Everything this script writes goes into one
# temporary folder, deleted on exit, except the build record next to the bundles,
# pr-quest-build.txt, which says how they were signed for scripts/ci/release-assets.sh.
set -euo pipefail

updater=(TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD PR_QUEST_UPDATER_PUBKEY)
updater_files=(UPDATER_PRIVATE_KEY_FILE UPDATER_PUBKEY_FILE)
mac_certificate=(APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD)
mac_api_key=(APPLE_API_ISSUER APPLE_API_KEY_ID APPLE_API_KEY_P8)
mac_account=(APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID)
win_azure=(
  AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET
  AZURE_SIGNING_ENDPOINT AZURE_SIGNING_ACCOUNT AZURE_SIGNING_PROFILE
)
win_pfx=(WINDOWS_PFX WINDOWS_PFX_PASSWORD)
# What this script sets for desktop-package; never taken from the caller, so a build can't pick up
# whatever identity or command the machine happens to have.
derived=(APPLE_SIGNING_IDENTITY APPLE_API_KEY APPLE_API_KEY_PATH PR_QUEST_WINDOWS_SIGN_COMMAND)

# Microsoft's signtool plugin for Artifact Signing, from
# https://www.nuget.org/packages/Microsoft.ArtifactSigning.Client/1.0.146
dlib_version=1.0.146
dlib_sha256=7761e5d8f31e54b764da21d33cd8b0a2940e1b05526c7dfcb5e94b0431426f70

for name in "${updater[@]}" "${updater_files[@]}" "${mac_certificate[@]}" "${mac_api_key[@]}" \
  "${mac_account[@]}" "${win_azure[@]}" "${win_pfx[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    unset "$name"
  fi
done
for name in "${derived[@]}"; do
  unset "$name"
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

triple=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [[ "${args[i]}" == --target ]]; then
    triple="${args[i + 1]:-}"
  fi
done
if [[ -z "$triple" ]]; then
  fail "Pass --target <triple>, so the build record goes next to that target's bundles."
fi
record="${CARGO_TARGET_DIR:-src-tauri/target}/$triple/release/bundle/pr-quest-build.txt"

allow_unsigned=false
case "${PR_QUEST_ALLOW_UNSIGNED_RELEASE:-}" in
  '') unset PR_QUEST_ALLOW_UNSIGNED_RELEASE ;;
  1) allow_unsigned=true ;;
  *) fail "PR_QUEST_ALLOW_UNSIGNED_RELEASE is \"$PR_QUEST_ALLOW_UNSIGNED_RELEASE\"; it can only be 1, for a dry run." ;;
esac
if [[ "$allow_unsigned" == true ]]; then
  if [[ "${GITHUB_EVENT_NAME:-}" == push ]]; then
    fail "PR_QUEST_ALLOW_UNSIGNED_RELEASE is set in a tag build, which must be signed. Only the dry run may set it."
  fi
  if any_set "${mac_certificate[@]}" "${mac_api_key[@]}" "${mac_account[@]}" "${win_azure[@]}" "${win_pfx[@]}"; then
    fail "PR_QUEST_ALLOW_UNSIGNED_RELEASE asks for an unsigned build, but signing secrets are set."
  fi
fi

unsigned() {
  if [[ "${PR_QUEST_RELEASE_BUILD:-}" == 1 && "$allow_unsigned" != true ]]; then
    fail "$1 A release build must be signed on macOS and Windows; set the signing secrets of the release environment (see RELEASING.md)."
  fi
  echo "::warning title=Unsigned build::$1"
}

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/package.XXXXXX")"
# What cleanup undoes: the macOS keychain and the keychain search list it replaced, and the
# certificate imported into the Windows store.
keychain=""
searched=()
thumbprint=""
cleanup() {
  if [[ -n "$keychain" ]]; then
    if [[ "${#searched[@]}" -gt 0 ]]; then
      security list-keychains -d user -s "${searched[@]}" || true
    fi
    security delete-keychain "$keychain" || true
  fi
  if [[ -n "$thumbprint" ]]; then
    pwsh -NoProfile -Command "Remove-Item -LiteralPath 'Cert:\\CurrentUser\\My\\$thumbprint' -DeleteKey" ||
      true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# The updater key pair. Tauri signs every update file with the private key, and the app trusts only
# the public key it was built with, so a release build stops here rather than half-way through.
if [[ "${PR_QUEST_RELEASE_BUILD:-}" == 1 ]]; then
  if any_set "${updater_files[@]}"; then
    if any_set TAURI_SIGNING_PRIVATE_KEY PR_QUEST_UPDATER_PUBKEY; then
      fail "Use the updater key from the secrets or the dry run's key files, not both."
    fi
    require_all "the dry run's updater key" "${updater_files[@]}"
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$UPDATER_PRIVATE_KEY_FILE")"
    PR_QUEST_UPDATER_PUBKEY="$(cat "$UPDATER_PUBKEY_FILE")"
    export TAURI_SIGNING_PRIVATE_KEY PR_QUEST_UPDATER_PUBKEY
  fi
  if [[ -z "${PR_QUEST_UPDATER_PUBKEY:-}" ]]; then
    fail "A release build needs the repository variable PR_QUEST_UPDATER_PUBKEY, the public half of the updater key."
  fi
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    fail "A release build needs TAURI_SIGNING_PRIVATE_KEY, a secret of the release environment, to sign the update files."
  fi
  # Without it, a key that has a password makes Tauri ask for one, which nobody can answer.
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
elif any_set "${updater[@]}" "${updater_files[@]}"; then
  fail "The updater key is set, but PR_QUEST_RELEASE_BUILD isn't 1, so nothing would use it."
fi

mac_keychain() {
  local password line identities count
  local -a listed=()
  password="$(openssl rand -hex 24)"
  keychain="$work/signing.keychain-db"
  security create-keychain -p "$password" "$keychain"
  # Locks after 6 hours, longer than any build.
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$password" "$keychain"
  (umask 077 && printf '%s' "$APPLE_CERTIFICATE" | base64 --decode >"$work/certificate.p12")
  security import "$work/certificate.p12" -k "$keychain" -f pkcs12 \
    -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >/dev/null
  rm -f "$work/certificate.p12"
  # Lets codesign use the key without a prompt nobody could answer.
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" \
    >/dev/null
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line#\"}"
    listed+=("${line%\"}")
  done < <(security list-keychains -d user)
  searched=(${listed[@]+"${listed[@]}"})
  security list-keychains -d user -s "$keychain" ${listed[@]+"${listed[@]}"}
  identities="$(security find-identity -v -p codesigning "$keychain" |
    sed -n 's/^.*"\(Developer ID Application: .*\)"$/\1/p' | sort -u)"
  count="$(printf '%s' "$identities" | grep -c . || true)"
  if [[ "$count" != 1 ]]; then
    fail "APPLE_CERTIFICATE must hold exactly one Developer ID Application identity, but it has $count."
  fi
  export APPLE_SIGNING_IDENTITY="$identities"
  echo "Signing as $APPLE_SIGNING_IDENTITY"
}

# The newest x64 signtool of the Windows SDKs on the machine.
signtool() {
  local found
  found="$(find "${WINDOWS_KITS_BIN:-/c/Program Files (x86)/Windows Kits/10/bin}" \
    -path '*/x64/signtool.exe' 2>/dev/null | sort -V | tail -n 1)"
  if [[ -z "$found" ]]; then
    fail "No x64 signtool.exe in the Windows SDK."
  fi
  cygpath -w "$found"
}

windows_azure() {
  local package="$work/dlib.zip" dir="$work/dlib" metadata actual
  if [[ ! "$AZURE_SIGNING_ENDPOINT" =~ ^https://[a-z0-9]+\.codesigning\.azure\.net/?$ ]]; then
    fail "AZURE_SIGNING_ENDPOINT is $AZURE_SIGNING_ENDPOINT, not an endpoint such as https://weu.codesigning.azure.net."
  fi
  if ! dotnet --list-runtimes 2>/dev/null | grep -q '^Microsoft\.NETCore\.App 8\.'; then
    fail "The Artifact Signing dlib needs the .NET 8 runtime, which this machine doesn't have."
  fi
  curl --fail --location --silent --show-error --output "$package" \
    "https://api.nuget.org/v3-flatcontainer/microsoft.artifactsigning.client/$dlib_version/microsoft.artifactsigning.client.$dlib_version.nupkg"
  actual="$(sha256sum "$package" | cut -d ' ' -f 1)"
  if [[ "$actual" != "$dlib_sha256" ]]; then
    fail "Microsoft.ArtifactSigning.Client $dlib_version has SHA-256 $actual, not the pinned $dlib_sha256."
  fi
  pwsh -NoProfile -Command "Expand-Archive -LiteralPath '$(cygpath -w "$package")' -DestinationPath '$(cygpath -w "$dir")'"
  metadata="$work/metadata.json"
  # Only the client secret in AZURE_* may sign: no other credential found on the machine.
  jq -n --arg endpoint "$AZURE_SIGNING_ENDPOINT" --arg account "$AZURE_SIGNING_ACCOUNT" \
    --arg profile "$AZURE_SIGNING_PROFILE" '{
      Endpoint: $endpoint,
      CodeSigningAccountName: $account,
      CertificateProfileName: $profile,
      ExcludeCredentials: [
        "ManagedIdentityCredential", "WorkloadIdentityCredential", "SharedTokenCacheCredential",
        "VisualStudioCredential", "VisualStudioCodeCredential", "AzureCliCredential",
        "AzurePowerShellCredential", "AzureDeveloperCliCredential", "InteractiveBrowserCredential"
      ]
    }' >"$metadata"
  local tool dlib
  tool="$(signtool)"
  dlib="$(cygpath -w "$dir/bin/x64/Azure.CodeSigning.Dlib.dll")"
  metadata="$(cygpath -w "$metadata")"
  # shellcheck disable=SC2089,SC2090 # for signCommandArgs in scripts/desktop/config.ts, not bash
  export PR_QUEST_WINDOWS_SIGN_COMMAND="\"$tool\" sign /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /d \"PR Quest\" /dlib \"$dlib\" /dmdf \"$metadata\" %1"
}

windows_pfx() {
  local pfx="$work/certificate.pfx" imported tool
  tool="$(signtool)"
  (umask 077 && printf '%s' "$WINDOWS_PFX" | base64 --decode >"$pfx")
  # shellcheck disable=SC2016 # PowerShell expands these, not bash
  imported="$(PFX_FILE="$(cygpath -w "$pfx")" pwsh -NoProfile -Command '
    $password = ConvertTo-SecureString $env:WINDOWS_PFX_PASSWORD -AsPlainText -Force
    $certificate = Import-PfxCertificate -FilePath $env:PFX_FILE -CertStoreLocation Cert:\CurrentUser\My -Password $password
    $certificate.Thumbprint' | tr -d '\r')"
  rm -f "$pfx"
  if [[ ! "$imported" =~ ^[0-9A-F]{40}$ ]]; then
    fail "Importing WINDOWS_PFX gave no certificate thumbprint."
  fi
  thumbprint="$imported"
  # shellcheck disable=SC2089,SC2090 # for signCommandArgs in scripts/desktop/config.ts, not bash
  export PR_QUEST_WINDOWS_SIGN_COMMAND="\"$tool\" sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /d \"PR Quest\" /sha1 $thumbprint %1"
}

signed=false
case "$(uname -s)" in
  Darwin)
    if any_set "${mac_certificate[@]}" "${mac_api_key[@]}" "${mac_account[@]}"; then
      require_all "macOS signing" "${mac_certificate[@]}"
      if any_set "${mac_api_key[@]}" && any_set "${mac_account[@]}"; then
        fail "Notarize with the App Store Connect API key (APPLE_API_*) or with an Apple Account (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID), not both."
      elif any_set "${mac_api_key[@]}"; then
        require_all "notarizing with the API key" "${mac_api_key[@]}"
        export APPLE_API_KEY="$APPLE_API_KEY_ID"
        export APPLE_API_KEY_PATH="$work/AuthKey_$APPLE_API_KEY_ID.p8"
        (umask 077 && printf '%s\n' "$APPLE_API_KEY_P8" >"$APPLE_API_KEY_PATH")
      elif any_set "${mac_account[@]}"; then
        require_all "notarizing with an Apple Account" "${mac_account[@]}"
      else
        # Gatekeeper refuses a signed but unnotarized app just like an unsigned one.
        fail "The macOS certificate is set but notarization isn't: set APPLE_API_ISSUER, APPLE_API_KEY_ID and APPLE_API_KEY_P8, or APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID."
      fi
      mac_keychain
      # Tauri would import the certificate into a keychain of its own; it's in ours already.
      unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_API_KEY_ID APPLE_API_KEY_P8
      signed=true
    else
      unsigned "No macOS signing secrets, so this build is unsigned and not notarized, and Gatekeeper warns before it opens."
    fi
    ;;
  MINGW* | MSYS* | CYGWIN*)
    if any_set "${win_azure[@]}" && any_set "${win_pfx[@]}"; then
      fail "Sign with Artifact Signing (AZURE_*) or with a certificate file (WINDOWS_PFX*), not both."
    elif any_set "${win_azure[@]}"; then
      require_all "Artifact Signing" "${win_azure[@]}"
      windows_azure
      signed=true
    elif any_set "${win_pfx[@]}"; then
      require_all "signing with a certificate file" "${win_pfx[@]}"
      windows_pfx
      unset WINDOWS_PFX WINDOWS_PFX_PASSWORD
      signed=true
    else
      unsigned "No Windows signing secrets, so SmartScreen warns before the installer runs."
    fi
    ;;
  *)
    if any_set "${mac_certificate[@]}" "${mac_api_key[@]}" "${mac_account[@]}" "${win_azure[@]}" "${win_pfx[@]}"; then
      fail "Linux builds aren't code signed, but macOS or Windows signing secrets reached this one."
    fi
    ;;
esac

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "signed=$signed" >>"$GITHUB_OUTPUT"
fi

rm -f "$record"
just desktop-package "$@"
mkdir -p "$(dirname "$record")"
printf 'target=%s\nsigned=%s\nunsigned_release=%s\n' "$triple" "$signed" "$allow_unsigned" >"$record"
