# Releasing the desktop app

[`.github/workflows/release.yml`](.github/workflows/release.yml) builds the installers, checks
them and publishes them to a draft GitHub Release. Nothing reaches users until you publish that
draft by hand.

## How a release runs

Pushing a tag that starts with `v` runs these jobs:

1. **Check the version.** The tag must be `v` followed by the `version` in `package.json`, and
   the tagged commit must be on the default branch. A version with a hyphen, such as
   `0.2.0-beta.1`, makes a prerelease.
2. **Check.** Type-checks, lints, checks formatting and runs the tests: `just check` without its
   build, since every build job builds anyway.
3. **Build**, once per platform, each on a runner with that processor: macOS on Apple Silicon
   (`macos-15`) and Intel (`macos-15-intel`), Windows x64, and Linux x64 and arm64. A build needs
   its own processor because `yarn install` fetches only that processor's Cursor SDK binaries.
   The macOS and Windows jobs use the `release` environment, so they wait until a reviewer
   approves it; see [Protect the signing secrets](#protect-the-signing-secrets).
   Each job packages the app, signs it when the signing secrets are set, and smoke-tests it with
   `yarn desktop:smoke`: the unpacked app on every platform, the app inside the mounted `dmg` on
   macOS, and the AppImage on Linux. Signed builds also get their signature checked, and macOS
   builds their notarization. The packaged update settings (`app-update.yml`) must set no update
   channel, which would let the app install older versions, and on a signed Windows build must
   name the publisher, so the app checks who signed an update before installing it.
4. **Publish the draft release.** Once every build has passed, one job gathers their files,
   merges the two macOS update files, and creates the draft release with all of them. Because only
   this job creates the release, parallel builds can't create duplicate releases. Re-running it
   uploads to the same draft again, replacing its files.

Running the workflow by hand from the **Actions** tab (**Release**, then **Run workflow**) is a
dry run. It builds and smoke-tests unsigned installers on every platform, keeps them as workflow
artifacts for 7 days, and publishes nothing.

As written, the workflow lets only the publish job write to the repository, and passes the
signing secrets only to the packaging step of a macOS or Windows tag build. That alone protects
nothing from someone who can push: a tag build runs the workflow file of the tagged commit, which
anyone with write access can change. The secrets are kept safe by repository settings instead,
described under [Protect the signing secrets](#protect-the-signing-secrets). The workflow never
runs for pull requests, so code from a fork never sees the secrets. In a fork without secrets, a
tag build still works, but its installers are unsigned.

### The macOS update file

electron-updater reads a single `latest-mac.yml` for each release, and it picks the arm64 or the
x64 zip from that file's list of files. Each macOS build job writes its own `latest-mac.yml`
naming only its own files, so the publish job merges the two lists into one. Any other file name
that two jobs both produce stops the release, since one upload would replace the other.

The other option was a single universal macOS app. It isn't used because a universal build needs
both processors' Cursor SDK binaries on one machine, which `yarn install` doesn't fetch. It would
also double the download for everyone.

## Make a release

1. Set the new version in `package.json` (`yarn version 0.2.0` does this) and merge the change to
   the default branch.
2. Tag the merged commit and push the tag:

   ```sh
   git switch main && git pull --ff-only
   git tag -a v0.2.0 -m "PR Quest 0.2.0"
   git push origin v0.2.0
   ```

3. When the **Release** run asks for a review of the `release` environment, check that it runs
   for your tag and the commit you merged, then approve it. The macOS and Windows builds wait
   until then.
4. Wait for the **Release** workflow to finish. If a build fails because of the runner, re-run
   the failed jobs. If it needs a code change, delete the draft release and the tag, then release
   a new patch version. Don't move a tag that has been pushed.
5. Review the draft release under **Releases**:
   - It has a `dmg` and a `zip` for `mac-arm64` and for `mac-x64`, a `win-x64.exe`, an AppImage
     and a `deb` for each Linux processor, a `.blockmap` next to each installer that has one, and
     `latest.yml`, `latest-mac.yml`, `latest-linux.yml` and `latest-linux-arm64.yml`.
   - `latest-mac.yml` lists both macOS zips.
   - Install it on each operating system you can, sign in, and run a review.
   - Edit the generated notes.
6. Publish the release. Installed apps find it the next time they check: when they start, and
   every 6 hours after that.

Never reuse a version that has been published, even if you delete the release. An app that
installed it won't update to a different build with the same version.

## Secrets and settings

Add these as secrets of the `release` environment (**Settings**, **Environments**, `release`,
**Environment secrets**), never as repository secrets: every workflow run on any branch can read
a repository secret. Set up the environment first, as described under
[Protect the signing secrets](#protect-the-signing-secrets).
Leave out all of a platform's secrets and its installers are built unsigned, with a warning on the
run. If only some of them are set, whichever ones are missing, the build stops instead of shipping
something half-signed, and so it does when both ways to notarize, or both ways to sign for
Windows, are set.

Once you have released a signed version, set the repository **variable** `REQUIRE_SIGNING` to
`true`. A tag build then stops when macOS or Windows would be unsigned, for example because a
secret was deleted or expired. Users of a signed version couldn't update to it: macOS installs an
update only when it's signed by the same developer, and a signed Windows app refuses an update
that its publisher didn't sign. Dry runs are always unsigned and ignore it.

| Secret                        | Platform | What it is                                                                            |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `MAC_CSC_LINK`                | macOS    | The Developer ID Application certificate as a `.p12`, base64-encoded                  |
| `MAC_CSC_KEY_PASSWORD`        | macOS    | The password of that `.p12`                                                           |
| `APPLE_API_KEY_P8`            | macOS    | The contents of the App Store Connect API key file, `AuthKey_<id>.p8`                 |
| `APPLE_API_KEY_ID`            | macOS    | That key's ID                                                                         |
| `APPLE_API_ISSUER`            | macOS    | The issuer ID shown above the list of keys                                            |
| `APPLE_ID`                    | macOS    | Instead of the API key: the Apple Account that notarizes                              |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS    | Instead of the API key: an app-specific password for that account                     |
| `APPLE_TEAM_ID`               | macOS    | Instead of the API key: the 10-character team ID                                      |
| `AZURE_SIGNING_ENDPOINT`      | Windows  | The Trusted Signing account's endpoint, such as `https://weu.codesigning.azure.net`   |
| `AZURE_SIGNING_ACCOUNT`       | Windows  | The Trusted Signing account name                                                      |
| `AZURE_SIGNING_PROFILE`       | Windows  | The certificate profile name                                                          |
| `AZURE_SIGNING_PUBLISHER`     | Windows  | The certificate's subject, such as `CN=Jane Doe, O=Jane Doe, L=Austin, S=Texas, C=US` |
| `AZURE_TENANT_ID`             | Windows  | The Microsoft Entra tenant of the app registration that signs                         |
| `AZURE_CLIENT_ID`             | Windows  | That app registration's client ID                                                     |
| `AZURE_CLIENT_SECRET`         | Windows  | A client secret of that app registration                                              |
| `WIN_CSC_LINK`                | Windows  | Instead of Trusted Signing: a code signing certificate as a `.pfx`, base64-encoded    |
| `WIN_CSC_KEY_PASSWORD`        | Windows  | The password of that `.pfx`                                                           |

macOS needs both certificate secrets and either the three `APPLE_API_*` secrets (recommended) or
the three Apple Account ones, not both. Windows needs either the seven Trusted Signing secrets or
both `.pfx` ones, not both. The API key reaches the build as a file in the runner's temporary
folder, which the packaging script deletes when it ends.

Publishing uses the workflow's own `GITHUB_TOKEN`, so it needs no token of yours.

The workflow builds with `PR_QUEST_RELEASE_BUILD=1`, which a build needs to check for updates and
to get electron-updater's files; see
[`electron-builder.config.ts`](electron-builder.config.ts).

One optional **variable** (not a secret): `PR_QUEST_RELEASE_REPO`, as `owner/repo`, names the
repository the app checks for updates and opens from **Help**. Without it, the workflow uses the
repository it runs in. Outside the workflow, builds use `RELEASE_REPO` in
[`src/desktop/release.ts`](src/desktop/release.ts) unless `PR_QUEST_RELEASE_REPO` is set for the
build.

`gh secret set` reads a value from a file or from standard input, which keeps it out of your
shell history; `--env release` makes it an environment secret:

```sh
base64 -i DeveloperID.p12 | gh secret set MAC_CSC_LINK --env release
gh secret set APPLE_API_KEY_P8 --env release < AuthKey_ABC123DEFG.p8
gh secret set MAC_CSC_KEY_PASSWORD --env release   # asks for the value
gh secret list                                     # repository secrets: none of the above
```

### Protect the signing secrets

Anyone who can push to the repository can change the workflow file in a commit, tag it, and so
run their own workflow when the tag is pushed. Three settings keep that from reaching the signing
secrets:

1. **The `release` environment.** Under **Settings**, **Environments**, create `release`:
   - **Required reviewers**: the maintainers who may approve a release. If you are the only one,
     leave **Prevent self-review** off, or nobody can approve.
   - **Deployment branches and tags**: **Selected branches and tags**, with one rule of the
     **Tag** type for `v*`. A run for a branch can't use the environment, even with approval.
   - **Environment secrets**: the signing secrets in the table above, and none of them as
     repository secrets. Delete any repository secret with those names.
2. **A tag ruleset.** Under **Settings**, **Rules**, **Rulesets**, add a **tag ruleset** named
   `release tags`, **Active**, targeting tags that match `v*`, with **Restrict creations**,
   **Restrict updates** and **Restrict deletions**. Under **Bypass list**, add only the
   **Repository admin** role, or the **Maintain** role too if maintainers release. Only they can
   then push, move or delete a `v*` tag.
3. **The `REQUIRE_SIGNING` variable**, once a signed version is out; see above.

The reviewer is the last check: a run waiting for approval runs whatever workflow file the tag's
commit has. Approve only a run for a tag you pushed, at a commit on the default branch. The
version check job also stops a tag that isn't on the default branch, but someone who changes the
workflow file can remove that check.

### The macOS certificate

You need a membership of the [Apple Developer Program](https://developer.apple.com/programs/)
(99 USD a year), and the Account Holder role to create a Developer ID certificate.

1. On a Mac, open **Keychain Access**, then **Keychain Access**, **Certificate Assistant**,
   **Request a Certificate From a Certificate Authority**. Enter your email address, choose
   **Saved to disk**, and save the request.
2. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list),
   add a certificate, choose **Developer ID Application**, and upload the request.
3. Download the certificate and open it, which adds it to your login keychain.
4. In Keychain Access, under **My Certificates**, right-click
   **Developer ID Application: _your name_ (_team ID_)**, choose **Export**, save it as a `.p12`
   and give it a password.
5. Store its base64 encoding as `MAC_CSC_LINK` and the password as `MAC_CSC_KEY_PASSWORD`, then
   delete the exported file.

### The App Store Connect API key, for notarization

1. In [App Store Connect](https://appstoreconnect.apple.com/access/integrations/api), open
   **Users and Access**, **Integrations**, **App Store Connect API**, and generate a team key.
   The **Developer** role is enough for notarization.
2. Download the `.p8` file. Apple lets you download it only once.
3. Store the file's contents as `APPLE_API_KEY_P8`, the key ID as `APPLE_API_KEY_ID`, and the
   issuer ID shown above the keys as `APPLE_API_ISSUER`.

To notarize with an Apple Account instead, create an app-specific password under **Sign-In and
Security** at [account.apple.com](https://account.apple.com), and find the team ID under
**Membership details** in your developer account.

### Windows: Azure Trusted Signing

Trusted Signing, which Microsoft now also calls Artifact Signing, keeps the certificate in Azure,
so there is no certificate file to protect. It costs about 10 USD a month. Microsoft validates
the identity first. Organizations can apply, and so can individual developers in some countries;
check the current list in Microsoft's documentation.

1. In an Azure subscription, register the `Microsoft.CodeSigning` resource provider and create a
   Trusted Signing account. Its region decides the endpoint, such as
   `https://weu.codesigning.azure.net` for West Europe.
2. Under the account, request an identity validation of the **Public** type and wait for it to be
   approved.
3. Create a certificate profile of the **Public Trust** type for that identity. Its certificate
   subject is the `AZURE_SIGNING_PUBLISHER` value. electron-builder writes it into the app as
   `publisherName`, and electron-updater checks an update's signer against it before installing
   the update, so keep it stable: if it changes, apps signed with the old one refuse the update.
4. In Microsoft Entra ID, create an app registration and give it a client secret. On the Trusted
   Signing account or the profile, give it the **Trusted Signing Certificate Profile Signer**
   role.
5. Store the endpoint, account name, profile name, publisher and the app registration's tenant
   ID, client ID and secret as the seven `AZURE_*` secrets. Client secrets expire, so note when
   to replace this one.

electron-builder installs the `TrustedSigning` PowerShell module on the runner when it signs.

### Windows: a certificate file instead

`WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` sign with a `.pfx` code signing certificate. Since June
2023, certificate authorities issue code signing keys only on hardware tokens or cloud HSMs, so a
new OV or EV certificate can't be exported as a `.pfx`. This route only works with an older
certificate that can be. Signing through a cloud HSM service needs a custom `sign` hook in
[`electron-builder.config.ts`](electron-builder.config.ts), which isn't written.

## What users see without signing

**macOS.** An unsigned build is only ad-hoc signed and isn't notarized. Gatekeeper refuses to open
it the first time: the user has to try once, then choose **Open Anyway** under **System
Settings**, **Privacy & Security**. On macOS 14 and earlier, right-clicking the app and choosing
**Open** also works. The app can't update itself, because macOS installs an update only into an
app signed by the same developer. Every new build also asks for the login password when it first
reads the keychain item an earlier build created.

**Windows.** SmartScreen shows "Windows protected your PC" before the installer runs, and the
user has to choose **More info**, then **Run anyway**. Some antivirus programs also flag unsigned
installers. Updates still install. A signed installer can still get a SmartScreen warning for a
while, until enough people have installed it for SmartScreen to trust it.

**Linux.** Nothing is signed. The AppImage runs once it's made executable, and the `deb`
installs with `sudo apt install ./pr-quest-<version>-<arch>.deb`. The AppImage updates itself.
An app installed from the `deb` never does, since electron-updater would install the new package
as root with only a checksum from the same release to trust; its **Help** menu opens the latest
release instead, and the user installs the new `deb` the same way.

## Limits

- Runners: `ubuntu-24.04-arm` is free for public repositories. For a private repository, use a
  larger arm64 runner or remove the Linux arm64 build from the matrix. `macos-15-intel` is
  GitHub's last Intel macOS image; when GitHub retires it, Intel Macs need a universal build or
  no build.
- Environments with required reviewers, and tag rulesets, are available for public repositories
  on every plan. A private repository needs GitHub Team or Pro for rulesets and environment
  secrets, and GitHub Enterprise for required reviewers; without reviewers, the tag ruleset is
  the only thing between someone who can push and the signing secrets.
- There is no Windows arm64 build: the Cursor SDK has no Windows arm64 binaries. Windows on Arm
  runs the x64 build under emulation.
- The workflow has only been checked with actionlint, and its scripts only run on a Mac. Before
  the first real release, make a dry run, then release a prerelease such as `0.1.0-rc.1` and
  delete its draft once it looks right.
