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

# Run the tests against a throwaway Postgres in Docker instead of the in-process PGlite
test-postgres:
    #!/usr/bin/env bash
    set -euo pipefail
    container=$(docker run --detach --rm --publish 127.0.0.1::5432 \
        --env POSTGRES_PASSWORD=pr-quest-test --env POSTGRES_DB=pr_quest_test postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b)
    trap 'docker stop "$container" >/dev/null' EXIT
    port=$(docker port "$container" 5432/tcp | head -n 1 | sed 's/.*://')
    # The image's init runs a socket-only server first, so wait for TCP.
    for _ in $(seq 1 120); do
        docker exec "$container" pg_isready --host 127.0.0.1 --username postgres --quiet && break
        sleep 0.5
    done
    PR_QUEST_TEST_DATABASE_URL="postgres://postgres:pr-quest-test@127.0.0.1:${port}/pr_quest_test" yarn test

# Run the pending Postgres migrations against DATABASE_URL (hosted mode)
db-migrate:
    yarn db migrate

# List the Postgres migrations DATABASE_URL hasn't run; fails while any is pending
db-status:
    yarn db status

# Rewrap every data key under PR_QUEST_MASTER_KEY after rotating it, so old keys can be dropped
db-rewrap-keys:
    yarn db rewrap-keys

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

# Type-check the UI, server and test projects
typecheck:
    yarn typecheck

# Type-check, then build the UI into dist/ and the server into dist-server/
build:
    yarn build

# Run every check CI runs
check: typecheck lint format-check test build
