# Developing PR Quest

## Checks

| Command             | What it does                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `yarn typecheck`    | Type-checks each package and its tests                                                        |
| `yarn lint`         | Lints with [oxlint](https://oxc.rs/docs/guide/usage/linter), type-aware                       |
| `yarn lint:fix`     | Applies oxlint's safe fixes                                                                   |
| `yarn format`       | Formats the repo with [oxfmt](https://oxc.rs/docs/guide/usage/formatter)                      |
| `yarn format:check` | Fails if a file isn't formatted                                                               |
| `yarn test`         | Runs every package's Vitest suite once (`yarn test:watch` keeps it open)                      |
| `yarn build`        | Type-checks, then builds the UI into `apps/web/dist/` and the server into `apps/server/dist/` |
| `yarn start`        | Builds, then runs the [production build](#production-build)                                   |

Each package also has its own `test` and `typecheck` scripts, and the two apps a `dev` script,
for example `yarn workspace @pr-quest/server test`. `yarn workspace @pr-quest/server build`
bundles only the server. With [just](https://just.systems) installed, `just check` runs the type
check, lint, format check, tests and build, as CI does on every pull request and every push to
`main`.

The Postgres storage tests run on [PGlite](https://pglite.dev), Postgres compiled to WebAssembly,
in-process, so `yarn test` needs no database. `just test-postgres` runs the whole suite against a
throwaway, digest-pinned `postgres:17-alpine` container in Docker instead, as CI's `test-postgres` job does with a
service container. To use a server of your own, set `PR_QUEST_TEST_DATABASE_URL`; each test file
works in its own schema and drops it afterwards.

## Production build

```sh
yarn start
```

`yarn start` runs `yarn build` first, which type-checks, builds the UI into `apps/web/dist/` and
bundles the server into `apps/server/dist/` with [esbuild](https://esbuild.github.io). It then
runs `node apps/server/dist/main.js`, which serves the API and the built UI together on
<http://127.0.0.1:4317>; there is no separate UI port. To run an existing build without
rebuilding, use `yarn workspace @pr-quest/server start`. Without an `apps/web/dist/` build the
server serves only the API and says so. The bundle leaves
`@cursor/sdk`, `@anthropic-ai/sdk`, `pg` and `pg-connection-string` out, so it still needs the
repo's `node_modules`.

### Hosted mode

`PR_QUEST_MODE` is `local` by default: one player on their own machine, listening on `127.0.0.1`
only. Local mode refuses a `PR_QUEST_HOST` other than `127.0.0.1`, and refuses the hosted-only
settings, so a typo can't expose the server.

`PR_QUEST_MODE=hosted` is groundwork for serving many players from one address. It needs
`PR_QUEST_PUBLIC_ORIGIN`, the origin browsers load PR Quest from (for example
`https://pr-quest.example`), listens on `PR_QUEST_HOST` (default `::`, every interface) and
accepts the Host names in `PR_QUEST_ALLOWED_HOSTS` (comma-separated, default the public origin's
host name). Every player brings their own keys, so hosted mode refuses to start with
`CURSOR_API_KEY`, `ANTHROPIC_API_KEY` or `LINEAR_API_KEY` set, and the server warns when the
public origin is plain `http:` to anything but loopback. Hosted mode also needs a sign-in that
tells players apart, which doesn't exist yet, so `yarn start` refuses to start in hosted mode.
Code that embeds the server supplies it through `startServer` in
[`apps/server/src/app/server.ts`](../apps/server/src/app/server.ts), along with its own storage or
the [Postgres storage](#hosted-storage).

### Hosted storage

Hosted mode keeps every player's state in Postgres instead of the state directory. It reads these
settings, only in hosted mode; local mode ignores `DATABASE_URL`:

- `DATABASE_URL`: a `postgres://` or `postgresql://` connection string. The server warns at startup
  when it reaches a host without TLS (no `sslmode`, or `sslmode=disable`) or with TLS that doesn't
  check the certificate (`sslmode=no-verify`), unless the host is private: a socket, loopback, an
  RFC 1918 address, a single-label name, `*.internal` or `*.flycast`. The host is the one `pg`
  connects to, so a `?host=` parameter counts over the URL's host name. Add `?sslmode=verify-full`
  otherwise; `pg` 9 will stop checking the certificate for `sslmode=require`.
- `PR_QUEST_MASTER_KEY`: 32 random bytes, base64-encoded, from `openssl rand -base64 32`. Keep it
  outside the database, as a deployment secret.
- `PR_QUEST_PREVIOUS_MASTER_KEYS`: comma-separated older master keys, during a rotation.
- `PR_QUEST_DATABASE_POOL_MAX`: connections per server instance, 1 to 100 (default 10). A connection
  waits at most 10 seconds for the pool, a statement runs at most 15 seconds and a transaction may
  sit idle for at most 30 seconds.

Players are keyed by their GitHub account id, which never changes, not by their login, which can be
renamed and then registered by someone else. `users` holds each id's current login, updated on
every sign-in. When a login turns up under a new id, the account that held it keeps its rows under
its own id, without a login, until it signs in under its new one, and the server warns; the new
owner starts empty. Code that embeds the server passes `{ id, login }` (a `GitHubUser`) to
`userScope`, `AppStorage` and the identity context, so it can't key anything by login alone. Local
mode keeps its folder per login.

Each player has one row per document (settings, game state, quest cache) in `user_documents`, as
JSON in the same versioned format as the files, so older runs' finding decisions are converted to
selections on load there too. Updates to a document take a row lock and apply the change to the
latest stored value, so two server instances don't lose each other's writes. A document from a
newer build stops that player's load with an error instead of being overwritten. An unreadable one
is copied once to `user_documents_quarantine` and replaced by a fresh document, with a warning.

Hosted mode still needs all of a player's requests on one server instance: run one instance, or
route each player to the same one with sticky sessions. The row locks keep their writes, but each
instance keeps the player's decrypted keys and settings in memory once it opens them, picks up
their interrupted review runs the first time it opens their game, and remembers in memory which
runs it is posting. A second instance serving the same player would keep using a key the player
has deleted or changed on the first, mark a Claude review still running on the first as failed,
follow the same Cursor run twice, and could post the same review twice.

The GitHub token and the Cursor, Anthropic and Linear keys are stored per player in
`user_secrets`, encrypted with AES-256-GCM under that player's data key. The data key is stored
in `user_data_keys`, itself encrypted under the master key, with the master key's id. Each
ciphertext is bound to its player's GitHub id and key name, so it can't be copied to another row.
A single key that doesn't decrypt is logged by login, id and name, counts as unset and is replaced
when the player saves it again; a data key the master keys can't unwrap still stops the load.
Hosted mode has no machine-wide keys or settings, so the Postgres storage refuses the machine scope.

Rotate the master key in two phases, so that no instance meets a data key wrapped by a key it
doesn't hold during a rolling deploy:

1. Add the new key to `PR_QUEST_PREVIOUS_MASTER_KEYS` on every instance and redeploy.
2. Make the new key `PR_QUEST_MASTER_KEY` and move the old one into
   `PR_QUEST_PREVIOUS_MASTER_KEYS`, then redeploy. Data keys are rewrapped as players load.
3. Run `just db-rewrap-keys` (`node apps/server/dist/db.js rewrap-keys` in a deployment) to rewrap
   the rest. It carries on past a key it can't rewrap, lists each on stderr and exits 1; fix those
   and run it again until it exits 0.
4. Drop the old key from `PR_QUEST_PREVIOUS_MASTER_KEYS` and redeploy.

The schema is created by plain SQL migrations in
[`apps/server/src/platform/postgres/migrations.ts`](../apps/server/src/platform/postgres/migrations.ts),
each run in one transaction (so no `CREATE INDEX CONCURRENTLY`), without the pool's statement
timeout and with a 60-second lock timeout. The server doesn't run them; it refuses to start until
they have run.

| Command               | In a deployment                           | What it does                                         |
| --------------------- | ----------------------------------------- | ---------------------------------------------------- |
| `just db-migrate`     | `node apps/server/dist/db.js migrate`     | Runs the pending migrations, each in one transaction |
| `just db-status`      | `node apps/server/dist/db.js status`      | Lists pending migrations; fails while any is         |
| `just db-rewrap-keys` | `node apps/server/dist/db.js rewrap-keys` | Rewraps every data key under the current master key  |

The commands take `DATABASE_URL` and the master keys from the environment only, never from
arguments, so they stay out of shell history, and never print them. Results go to stdout, failures
to stderr, and a failure exits 1.

To roll forward, run `db-migrate` with the new build's code, then deploy it; a release command
that runs `migrate` before every deploy does both. Migrations only go forward. To roll back,
deploy the older build: as long as the newer build's migrations only add things, the older
build's `migrate` warns about them and runs nothing, and the server starts with a warning. Write a
change that an older build can't run beside, such as dropping or renaming a column, as its own
later migration with `breaking: true`. Once that has run, older builds refuse both to migrate and
to start, and rolling back past it means restoring a backup.

When `startServer` opens the database from `DATABASE_URL`, the identity resolver gets it as
`IdentityContext.database`, without `close`, for the sign-in's own tables such as sessions. Those
tables belong in the same migrations. `IdentityContext.secretsFor(user)` returns the player's
secret store, the one their API keys are in, for the sign-in's own secrets such as the sealed
GitHub token; it is opened once and kept until `releaseUser(user)`.

## Tooling notes

- **oxlint** reads `.oxlintrc.json`. Type-aware rules such as `no-floating-promises` run through
  `oxlint-tsgolint`. The repo's own rules (no type assertions, no barrel files, no enums and the
  [import rules](#import-rules)) are a small oxlint JS plugin in `oxlint-plugins/local.js`. oxfmt
  reads `.oxfmtrc.json`. For editor support, install the recommended
  [Oxc extension](https://marketplace.visualstudio.com/items?itemName=oxc.oxc-vscode).
- **TypeScript 7**, the native compiler, ships as the `typescript` package. It has no `tsserver`,
  so keep your editor on its bundled TypeScript rather than "Use Workspace Version".
- **Yarn** older than 4.17.1 can't install TypeScript 7; Volta picks the pinned 4.18.1.
- **React Compiler.** The UI is built with `babel-plugin-react-compiler`, which memoises
  components and hooks. `vite build` prints how many it memoised and lists any it skipped; a
  skipped component still works, it just isn't memoised. Vitest reuses `apps/web/vite.config.ts`,
  so the UI tests run the compiled components. oxlint checks the Rules of React the compiler relies
  on (`react/purity`, `react/refs`, `react/immutability` and the others in `.oxlintrc.json`), and
  `react/todo` warns about code the compiler can't compile yet.
- **Sign in with GitHub for a team.** A team can commit its OAuth App's client ID as
  `DEFAULT_GITHUB_CLIENT_ID` in
  [`apps/server/src/platform/config.ts`](../apps/server/src/platform/config.ts), so nobody has to
  set `PR_QUEST_GITHUB_CLIENT_ID`. A client ID isn't secret.

## Project structure

The repo is a set of [Yarn workspaces](https://yarnpkg.com/features/workspaces). The server and
the UI are separate packages, each with its own dependencies, TypeScript and Vitest config, and
they share code only through `@pr-quest/contract`. Tests sit next to the code they test.

```text
apps/
  server/         @pr-quest/server, the API (Node: tsx in development, an esbuild bundle in
                  production)
    src/
      main.ts     entry point of the production build
      app/        composition root: dev.ts (dev entry), server.ts (startServer, for embedding),
                  app.ts, the HTTP route tables, identity.ts (who a request acts as), storage.ts
                  (where secrets, settings and player state live), postgresStorage.ts (the same
                  in Postgres, for hosted mode), db.ts (the database commands), per-user
                  sessions and state dirs
      features/   one folder per feature, listed below
      platform/   router and security guards, config, SSE events, GitHub API wrapper, rate
                  limits, private files and secrets, time zones, envelope encryption, Postgres
                  (postgres/)
  web/            @pr-quest/web, the React UI (Vite)
    src/
      main.tsx    entry point
      app/        composition root: App.tsx, the header controls, the game controller hook and
                  the live event stream
      features/   one folder per feature, listed below
      platform/   API client, store, Modal, Popover, Tooltip, formatting, notifications, styles
packages/
  contract/       @pr-quest/contract, what the server and UI agree on: the API types and routes
                  (api.ts), the ports, the review prompt and result schema, the Cursor review
                  gate, the existing-comments filter and finding selection
scripts/
  restructure.ts  moves a branch's files from the old src/ layout; see below
docs/             this file, how PR Quest works, the API spike and the README screenshots
```

Both apps split their code into the same features, so a feature has a server half and a UI half:

| Feature    | Server                                              | UI                                 |
| ---------- | --------------------------------------------------- | ---------------------------------- |
| `auth`     | GitHub device flow, token resolution                | the GitHub account control         |
| `settings` | API keys, review provider and model settings        | the settings dialog                |
| `game`     | XP, levels, achievements, streaks, the state store  | HUD, toasts, XP popups             |
| `quests`   | GitHub and Linear clients, quest cache and polling  | the quest board, filters and cards |
| `reviews`  | review runs, Cursor and Claude reviews, diff budget | review result and approve dialog   |

Each feature folder has an `index.ts` that is its public entry. Other code imports from
`@pr-quest/contract/<module>`, such as `@pr-quest/contract/api`; the package has no build step and
exports its TypeScript source.

### Import rules

`yarn lint` enforces these:

- `@pr-quest/server` and `@pr-quest/web` use `@pr-quest/contract`, which uses no other package.
  The allowed edges are `PACKAGE_GRAPH` in `oxlint-plugins/local.js`, and each must also be a
  dependency in the importing package's `package.json`. Neither app exports anything, and a
  relative import never leaves its package.
- Inside an app, `platform/` never imports from a feature or `app/`.
- A feature imports its own files, its app's `platform/` and `@pr-quest/contract`. It reaches
  another feature only through that feature's `index.ts`. Tests may also use another feature's
  `test-utils/`.
- Only `app/` and `main.ts` import from `app/`, and they also go through each feature's
  `index.ts`.
- There are no import cycles. The features form one direction: `reviews` uses `quests`, `game`
  and `settings`; `quests` uses `game` and `settings`; `game` uses `settings`; `settings` uses
  `auth`.

`yarn typecheck` adds one more: `@pr-quest/contract` runs in the browser and in Node, so it is
type-checked with neither DOM nor Node types, and the UI without Node types.

## Moving a branch from the old layout

Before the workspaces, both halves lived under `src/`, as `src/features/<name>/server/` and
`src/features/<name>/ui/`. A branch started before the move should merge `main` first, so git
follows the renamed files, and then run the script, which moves any files still under `src/` and
fixes the relative imports that no longer resolve:

```sh
git merge origin/main
# If package.json conflicts, resolve it first: Node won't start while it has conflict markers.
node scripts/restructure.ts
yarn install && yarn format && yarn typecheck && yarn lint
```

What to expect from the merge:

- `CONFLICT (file location)` for files the branch added under `src/`. Git has already put them in
  the new folders, so `git add` them.
- Many files show as conflicted only because they were renamed; they have no conflict markers.
- Conflicting import lines already have the right paths on the branch's side once the script has
  run.
- Dependencies the branch added to the root `package.json` belong in `apps/server/package.json` or
  `apps/web/package.json` now; the root keeps only repo-wide tools. Nothing fails if you forget,
  because Yarn hoists every package to the root `node_modules`.
- For a `yarn.lock` conflict, take `main`'s side and let `yarn install` add the branch's
  dependencies back.
- The script lists paths it can't fix, such as one that now points into the other app. It leaves
  paths relative to a build output, such as `../dist`, alone.
- `src/desktop/` moves to `apps/desktop/src/`, which needs its own `package.json` and an entry in
  `PACKAGE_GRAPH`.

Don't run the script before merging: git then sees two unrelated copies of every file and
conflicts far more. Running it again changes nothing once every path resolves.
