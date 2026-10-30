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

# Lint the whole repo
lint:
    yarn lint

# Type-check the UI, server and test projects
typecheck:
    yarn typecheck

# Type-check, then build the UI into dist/
build:
    yarn build

# Run every check CI runs
check: typecheck lint test build
