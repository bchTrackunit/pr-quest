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

# Run the API without file watching, plus the UI dev server
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

# Type-check each package and its tests
typecheck:
    yarn typecheck

# Type-check, then build the UI into apps/web/dist/
build:
    yarn build

# Run every check CI runs
check: typecheck lint format-check test build
