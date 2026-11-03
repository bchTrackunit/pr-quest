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

# Spike: build the Tauri app and dmg for this Mac into src-tauri/target/release/bundle/ (needs Rust)
tauri-package *args:
    yarn tauri:package {{ args }}

# Spike: check the packaged Tauri app, or the executable given
tauri-smoke executable="src-tauri/target/release/bundle/macos/PR Quest.app/Contents/MacOS/pr-quest":
    yarn desktop:smoke {{ quote(executable) }}

# Spike: idle memory of the packaged Tauri app, and what quitting and crashes stop
tauri-measure executable="":
    node scripts/tauri-measure.ts {{ if executable == "" { "" } else { quote(executable) } }}

# Run every check CI runs
check: typecheck lint format-check test build
