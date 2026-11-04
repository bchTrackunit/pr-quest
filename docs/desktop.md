# The desktop app

The desktop app is the same server and UI in a native window. A small [Tauri](https://tauri.app)
shell (Rust, in [`apps/desktop/src-tauri/`](../apps/desktop/src-tauri)) opens the operating system's own web view (WebKit on
macOS and Linux, WebView2 on Windows) and starts the server as a sidecar: a Node binary bundled
with the app runs [`apps/desktop/src/sidecar/main.ts`](../apps/desktop/src/sidecar/main.ts) in local mode.
The window shows only PR Quest. `http`, `https` and `mailto` links, such as a PR on GitHub, open
in your browser; links with any other scheme and navigation away from the app are blocked.
Opening the app a second time brings the open window to the front.

```sh
just desktop-dev        # run the shell from source (a debug build) with its log in the terminal
just desktop-package    # build the app and installers for this machine
just desktop-smoke      # check what desktop-package made
just desktop-check      # Rust format check, Clippy and unit tests
just cargo-deny         # audit the Rust crates (needs `cargo install cargo-deny --locked`)
```

Building needs [rustup](https://rustup.rs), which installs the Rust that `rust-toolchain.toml`
(at the repo root, so rustup finds it from wherever cargo runs) pins, as well as Node and Yarn, and on Linux the
WebKitGTK development packages; on Debian and Ubuntu:

```sh
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev \
  libdbus-1-dev libssl-dev libxdo-dev patchelf file
```

## Packaging

`just desktop-package` builds for the operating system and processor it runs on, or for
`--target <triple>`. The bundles land in `apps/desktop/src-tauri/target/<triple>/release/bundle/` (under
`$CARGO_TARGET_DIR` when that is set):

| Target                      | Bundles                                                       |
| --------------------------- | ------------------------------------------------------------- |
| `aarch64-apple-darwin`      | `macos/PR Quest.app` and `dmg/PR Quest_<version>_aarch64.dmg` |
| `x86_64-apple-darwin`       | `macos/PR Quest.app` and `dmg/PR Quest_<version>_x64.dmg`     |
| `x86_64-unknown-linux-gnu`  | `appimage/*.AppImage` and `deb/*.deb`                         |
| `aarch64-unknown-linux-gnu` | `appimage/*.AppImage` and `deb/*.deb`                         |
| `x86_64-pc-windows-msvc`    | `nsis/PR Quest_<version>_x64-setup.exe`                       |

`--bundles app` (or `appimage`, `deb`, `nsis`) builds fewer. `--skip-build` reuses `apps/web/dist/`, and
`--layout-only` stops after laying out the sidecar, which `cargo` needs before it can build the
shell. `--compile-only` stops after compiling the shell, with no signing settings, and
`--skip-compile` signs and bundles what it compiled, after laying out the sidecar's packages and
Node again; the release workflow compiles in one job, without its signing secrets, and bundles
in another, from a fresh checkout. Each target takes Node from nodejs.org at a pinned version and SHA-256
([`apps/desktop/scripts/desktop/targets.ts`](../apps/desktop/scripts/desktop/targets.ts)), and the Cursor SDK's native parts
(its sandbox, `rg` and the tree-sitter binding) from `node_modules`. `yarn install` fetches only
this machine's copy of those, so the build stops if the target's `@cursor/sdk-<os>-<cpu>` package
is missing or another platform's would be bundled. On an Intel Mac, or an Intel CI runner, a
plain `yarn install` gets the right one. To build `x86_64-apple-darwin` on Apple silicon, add
`supportedArchitectures` with `cpu: [current, x64]` to `.yarnrc.yml` for the install, without
committing it.

The macOS dmg step retries up to 3 times: `hdiutil create` often fails with "Resource busy" the
first time, and a leftover mount of the volume would break every later attempt, so each attempt
detaches it first. On Linux, the AppImage must not bundle `libwayland-client`, which breaks the
app on newer Wayland desktops ([tauri#15665](https://github.com/tauri-apps/tauri/issues/15665)).
The linuxdeploy that Tauri CLI 2.12 uses leaves it out already; if a later one doesn't, the
package step takes it out and repacks with a pinned `appimagetool` and runtime.

## Smoke test

`just desktop-smoke [artifact]` starts the packaged app in smoke mode (`PR_QUEST_SMOKE_TEST=1`)
with a throwaway state directory and without your `CURSOR_API_KEY`, `ANTHROPIC_API_KEY` and
`LINEAR_API_KEY`, prints one `[smoke] ok` or `[smoke] FAIL` line per check, quits, and exits
non-zero if any failed. Without an artifact it checks the app, AppImage or installer that
`desktop-package` made for this machine (or `--target`). It also takes a `.dmg` (mounted and
detached again), a `.deb` (unpacked), a `-setup.exe` (installed silently into a temporary
folder and uninstalled) or an executable.

The checks: the bundle ships Node as `pr-quest-node`, never as `node`; the OS keychain can make,
read and delete a data key; the UI renders with nothing blocked by its Content Security Policy;
the start-up link leaves the window on `/` and works only once; the request secret travels as an
`HttpOnly` cookie scripts can't read; the page can't call the shell or its plugins over IPC;
**View > Reload**, which has the server issue a new start-up link, brings the UI back; the
updater builds with its key; the server refuses a request without the secret; a saved key is encrypted on disk;
both SDKs load with their native parts; and a call with a made-up key reaches Cursor and
Anthropic and is refused as unauthenticated. The live event stream needs a GitHub sign-in too,
so without one, as on CI, the cookie check confirms the events route accepts the cookie instead
of opening the stream.

`--headless` (Linux) runs it under `xvfb-run` in its own D-Bus session with a throwaway unlocked
gnome-keyring, so it needs `xvfb`, `xauth`, `dbus` and `gnome-keyring`. `--no-keychain` is for a
machine without a keychain: the keychain check is skipped and the encryption check instead
confirms that saved keys stay in memory. The app's smoke mode refuses to start without
`PR_QUEST_STATE_DIR`, so it never touches your real state. On macOS, `just desktop-measure`
reports the packaged app's idle memory per process and checks that quitting stops the server,
that a crashed server is restarted, and that the app gives up after 3 crashes.

## The window and the server

The server only answers requests carrying a secret made fresh at each start, which the window
gets as an `HttpOnly`, `SameSite=Strict` cookie from a one-time start-up link, so other programs
and pages on your machine can't call it even though it listens on `127.0.0.1`. `GET /api/health`
is the exception. The web view has no developer tools in a packaged app, and every browser
permission is denied except notifications for the app's own pages.

If the server stops unexpectedly, the app starts it again and reloads the window, up to 3 times in
10 minutes; after that, or if it can't start at all, the app shows what went wrong and where its
log is, then quits. Quitting waits at most 5 seconds for the server to stop. On Windows the server
runs without a console window, in a job object that ends it with the app.

**Unsigned builds.** Without signing settings the app is unsigned, so macOS Gatekeeper and
Windows SmartScreen warn before the first start. On macOS 15 and later, open the app once, then
choose **Open Anyway** in **System Settings > Privacy & Security**; on earlier versions,
right-click the app and choose **Open**. macOS may also ask for your login password when a
rebuilt app reads the keychain entry an earlier build made. On Windows, choose **More info** and
**Run anyway**. An AppImage needs to be made executable (`chmod +x`) and FUSE; without FUSE, set
`APPIMAGE_EXTRACT_AND_RUN=1`.

**Linux graphics.** With the proprietary NVIDIA driver, WebKitGTK can show a blank or flickering
window. Start the app with `WEBKIT_DISABLE_DMABUF_RENDERER=1` in its environment to work around
it.

## State

The app uses the same `~/.pr-quest` (or `PR_QUEST_STATE_DIR`) and `.env` as `yarn start`; see
[Where state lives](../README.md#where-state-lives). Don't run both on the same state directory at once: each
keeps its own copy in memory and overwrites the other's writes. The app picks a free port the
first time and reuses it, so the board's filters and presets, which the web view keeps per
address, survive a restart; if another program has taken the port since, the app picks a new
one and the board starts from its defaults. It ignores `PR_QUEST_PORT` and `PR_QUEST_UI_PORT`,
and refuses to start with `PR_QUEST_MODE=hosted`.

The port and the choices you make in the app's dialogs are kept in `desktop.json`, and the log in
`main.log`, which starts over as `main.old.log` past 5 MB:

| OS      | `desktop.json`                                      | `main.log`                                |
| ------- | --------------------------------------------------- | ----------------------------------------- |
| macOS   | `~/Library/Application Support/com.prquest.desktop` | `~/Library/Logs/com.prquest.desktop`      |
| Linux   | `~/.config/com.prquest.desktop`                     | `~/.local/share/com.prquest.desktop/logs` |
| Windows | `%APPDATA%\com.prquest.desktop`                     | `%LOCALAPPDATA%\com.prquest.desktop\logs` |

**Saved keys.** The app keeps the GitHub token and the API keys from Settings in
`secrets.encrypted.json`, encrypted (AES-GCM) with a data key it keeps in the OS keychain as
`com.prquest.desktop` / `secrets-data-key`: the macOS Keychain, the Windows Credential Manager,
or the Secret Service on Linux (GNOME Keyring, or KWallet 5.97 and later). Only the macOS
Keychain asks you before another app reads the entry. The Windows Credential Manager and the Secret
Service have no per-app access control, so any program running as you can read the data key
there, and with it decrypt the file; on those systems the encryption keeps the keys out of
backups and other users' reach, not away from your own programs. Whenever it finds a
`secrets.json`, it imports it. If that file is newer than the encrypted one, as when `yarn start`
saved a key since, its keys replace the encrypted ones; otherwise only keys the encrypted file
lacks are taken. The log names any key that was replaced or kept, never its value. The app
decrypts the result to check it before deleting `secrets.json`; no plain copy is kept. If the
check fails, both files stay as they are and the app offers to try again or to continue without
saved keys. From then on, `yarn start` no longer sees those keys, so set them in `.env` or the
environment for it.

Without a usable keychain, such as on Linux without a Secret Service, the app reads
`secrets.json` but keeps new keys in memory until it quits, and says so once in a dialog.
Deleting a key, as **Sign out** does, removes it from `secrets.json` too, so it doesn't come back
on the next start. On Linux and Windows, choosing **Save Them Unencrypted** there, and confirming
it, writes `secrets.json` from then on, and the choice is kept in `desktop.json`. macOS never
offers that, so it never saves a key there. If `secrets.encrypted.json` exists but the keychain isn't
available, the app starts without saved keys and never writes `secrets.json`, so the encrypted
file stays the only copy. Each value is bound to its key's name, and the file names the data key
it was encrypted with by a short hash. If that isn't the keychain's data key, as after the
keychain entry was deleted and the app made a new one, the app says so, starts without saved
keys, keeps new ones in memory and leaves the file alone; **Start Over** moves it aside as
`secrets.encrypted.<key id>.<time>.json` (with `-1`, `-2` and so on if that name is taken) and saves keys with the new data key. If the file is
damaged, or names the keychain's data key but doesn't decrypt with it, as when it was changed, the
app says which and starts without saved keys; the file is left in place until you save a key,
which moves it aside the same way, as `unknown-key` when the file names no data key, and never
deletes it. For a damaged file it offers to try again, as after restoring it from a backup;
for one that doesn't decrypt, where trying again can't help, it offers **Start Over**.

## Updates

A release build checks `https://github.com/<repo>/releases/latest/download/latest.json` at start
and every 6 hours. A newer version downloads in the background, and the updater checks its
signature against the public key built into the app before keeping it; the app then offers to
restart into it, or installs it when you quit. It never installs an older or the same version.
Set `PR_QUEST_DISABLE_UPDATES=1` to turn updates off. The `.deb` never updates itself, since the
package manager owns it; **Help > Download the Latest Version** opens the latest release. Any
other build, including a plain `just desktop-package`, never checks for updates.

A release build is one packaged with `PR_QUEST_RELEASE_BUILD=1`, `PR_QUEST_RELEASE_REPO` set to
the GitHub `owner/name` it checks and that **Help** opens, and `PR_QUEST_UPDATER_PUBKEY` set to
the updater's public key. It stops if the repository is still the `CHANGE-ME` placeholder (in any
case) or the key is missing, and on macOS and Windows if it wouldn't be signed (see
[Signing](#signing)), unless `PR_QUEST_ALLOW_UNSIGNED_RELEASE=1`, which the release workflow sets
only for its dry runs. With `TAURI_SIGNING_PRIVATE_KEY` (and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if it has one) it also writes the update files next to the
bundles: `PR Quest.app.tar.gz`, the AppImage and the `-setup.exe`, each with a `.sig`.
`just desktop-verify-updater <file>` checks a `.sig` against the key. Make a key pair with
`yarn workspace @pr-quest/desktop exec tauri signer generate`. The release workflow never gives
its compile or bundle jobs the private key: it makes the macOS update archive itself and signs the
update files in a job of their own, then uploads them with a `latest.json` that lists them.

## Signing

Signing is off unless these are set in the environment of `just desktop-package`. Without an
identity on macOS, Tauri signs the whole app ad hoc, with the hardened runtime and only the two
entitlements Node needs, `allow-jit` and `disable-library-validation`
([`entitlements-ad-hoc.plist`](../apps/desktop/scripts/desktop/entitlements-ad-hoc.plist)). The
bundle is sealed, and the bundled Node loses the official binary's debugging entitlements such as
`get-task-allow`, so no debugger can attach to it; the package step checks the result. Publishing
a release is described in [RELEASING.md](../RELEASING.md).

| Variable                                                  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APPLE_SIGNING_IDENTITY`                                  | The Developer ID Application identity, already imported into a keychain. Every Mach-O file in the sidecar is signed with the hardened runtime first, then Tauri signs the app and Node with `apps/desktop/src-tauri/entitlements.plist`, which allows only JIT; the package step refuses a Node with any other entitlement. Ad-hoc (`-`) is refused, because library validation would stop Node from loading the SDK's native parts. |
| `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH` | Notarize with an App Store Connect API key.                                                                                                                                                                                                                                                                                                                                                                                          |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`             | Or notarize with an Apple ID and an app-specific password.                                                                                                                                                                                                                                                                                                                                                                           |
| `PR_QUEST_WINDOWS_SIGN_COMMAND`                           | A command with `%1` for the file, such as `trusted-signing-cli -e <endpoint> -a <account> -c <profile> %1` or `signtool sign /fd SHA256 /tr <url> /td SHA256 /sha1 <thumbprint> %1`. It signs the sidecar's `.node`, `.exe` and `.dll` files, then Tauri uses it for the app and the installer.                                                                                                                                      |
