# Developing PR Quest

## Checks

| Command                | What it does                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `yarn typecheck`       | Type-checks each package and its tests                                                        |
| `yarn lint`            | Lints with [oxlint](https://oxc.rs/docs/guide/usage/linter), type-aware                       |
| `yarn lint:fix`        | Applies oxlint's safe fixes                                                                   |
| `yarn format`          | Formats the repo with [oxfmt](https://oxc.rs/docs/guide/usage/formatter)                      |
| `yarn format:check`    | Fails if a file isn't formatted                                                               |
| `yarn test`            | Runs every package's Vitest suite once (`yarn test:watch` keeps it open)                      |
| `yarn build`           | Type-checks, then builds the UI into `apps/web/dist/` and the server into `apps/server/dist/` |
| `yarn start`           | Builds, then runs the [production build](#production-build)                                   |
| `yarn desktop:package` | Packages the [desktop app](desktop.md)                                                        |

Each package also has its own `test` and `typecheck` scripts, and the two apps a `dev` script,
for example `yarn workspace @pr-quest/server test`. `yarn workspace @pr-quest/server build`
bundles only the server. With [just](https://just.systems) installed, `just check` runs the type
check, lint, format check, tests and build, as CI does on every pull request and every push to
`main`. It doesn't build the desktop app's Rust shell; `just desktop-check` and `just cargo-deny`
check that.

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
`@cursor/sdk` and `@anthropic-ai/sdk` out, so it still needs the repo's `node_modules`.

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
tells players apart and storage for each of them, which don't exist yet, so `yarn start` refuses
to start in hosted mode. Code that embeds the server supplies them through `startServer` in
[`apps/server/src/app/server.ts`](../apps/server/src/app/server.ts).

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
  desktop/        @pr-quest/desktop, the desktop app (see desktop.md)
    src/          the server side: the sidecar the Tauri shell starts (sidecar/), its secrets,
                  preferences and smoke checks; it embeds @pr-quest/server
    src-tauri/    the Tauri shell, in Rust
    scripts/      packaging, signing, smoke tests and measurements of the desktop app
  server/         @pr-quest/server, the API (Node: tsx in development, an esbuild bundle in
                  production)
    src/
      main.ts     entry point of the production build
      app/        composition root: dev.ts (dev entry), server.ts (startServer, for embedding),
                  app.ts, the HTTP route tables, identity.ts (who a request acts as), storage.ts
                  (where secrets, settings and player state live), per-user sessions and state
                  dirs
      features/   one folder per feature, listed below
      platform/   router and security guards, config, SSE events, GitHub API wrapper, rate
                  limits, private files and secrets
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
docs/             this file, how PR Quest works, the desktop app, the API spike and the README
                  screenshots
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
  `@pr-quest/desktop` uses `@pr-quest/server`, which exports only what embedding it takes
  (`@pr-quest/server/server`, `/privateFiles` and `/secrets`); nothing uses `@pr-quest/desktop`.
  The allowed edges are `PACKAGE_GRAPH` in `oxlint-plugins/local.js`, and each must also be a
  dependency in the importing package's `package.json`. The web app and the desktop app export
  nothing, and a relative import never leaves its package.
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
