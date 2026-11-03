set dotenv-load := false

# List the available recipes
default:
    @just --list

# Install dependencies with the pinned Yarn version
install:
    yarn install --immutable

# Run the API (restarts on change) and the UI dev server
dev:
    yarn dev

# Run the production build (`just build` first): the API and the UI on one port
start:
    yarn start

# Run the unit tests once
test:
    yarn test

# Lint the whole repo with oxlint, including the type-aware rules
lint:
    yarn lint

# Apply oxlint's safe fixes
lint-fix:
    yarn lint:fix

# Format the whole repo with oxfmt
format:
    yarn format

# Fail if any file isn't formatted with oxfmt
format-check:
    yarn format:check

# Type-check the UI, server, desktop and test projects
typecheck:
    yarn typecheck

# Type-check, then build the UI into dist/ and the server into dist-server/
build:
    yarn build

# Package the desktop app (default: for this machine) into src-tauri/target/<triple>/release/bundle/; e.g. `just desktop-package --target x86_64-apple-darwin`
[positional-arguments]
desktop-package *args:
    node scripts/desktop-package.ts "$@"

# Run the desktop shell from source (debug build), with its log in the terminal
desktop-dev:
    node scripts/desktop-package.ts --layout-only
    node node_modules/@tauri-apps/cli/tauri.js dev

# Smoke-test a packaged desktop app: a .app, .dmg, .AppImage, .deb, -setup.exe or executable (default: what desktop-package made)
[positional-arguments]
desktop-smoke *args:
    node scripts/desktop-smoke.ts "$@"

# macOS: idle memory of the packaged app, and what quitting and crashes stop and restart
desktop-measure executable="":
    node scripts/desktop-measure.ts {{ if executable == "" { "" } else { quote(executable) } }}

# Check an updater artifact's .sig against the app's updater key (PR_QUEST_UPDATER_PUBKEY if set)
desktop-verify-updater artifact:
    node scripts/verify-updater-signature.ts {{ quote(artifact) }}

# Format check, Clippy and unit tests of the Rust shell (lays out the sidecar first, which tauri-build needs)
desktop-check:
    node scripts/desktop-package.ts --layout-only
    cargo fmt --manifest-path src-tauri/Cargo.toml --check
    cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
    cargo test --manifest-path src-tauri/Cargo.toml --locked

# Audit the Rust shell's crates: advisories, licenses, bans and sources (needs `cargo install cargo-deny --locked`)
cargo-deny:
    cargo deny --manifest-path src-tauri/Cargo.toml check

# Run every check CI runs
check: typecheck lint format-check test build
