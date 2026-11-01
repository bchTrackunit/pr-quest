# PR Quest

PR Quest is a small local web app that turns the pull requests you've been asked to review into
quests. Each open review request becomes a card with a difficulty tier based on its diff size.
From a card you can send a reviewer to the PR (a Cursor cloud agent, or Claude reading the
diff), read its findings, post them to GitHub, or approve the PR. Real review actions earn XP,
levels, a daily streak and achievements.

The board and server run on your machine; only the reviewer runs elsewhere, in Cursor's cloud or
at Anthropic. The server binds to `127.0.0.1` only, because it acts as you on GitHub with your
token. It also accepts browser requests only from its own UI and API origins, as described in
[Local server protections](#local-server-protections).

## Prerequisites

- **A GitHub token** from one of two places. PR Quest lists, approves and posts reviews as that
  user.
  - [Sign in with GitHub](#sign-in-with-github) from the app. This needs a GitHub OAuth App's
    client ID, set up once.
  - Or the **GitHub CLI**, logged in with `gh auth login`. PR Quest reads its token with
    `gh auth token`. Check it with `gh auth status`.
- **Node and Yarn through [Volta](https://volta.sh)**. Node 24.22.1 and Yarn 4.18.1 are pinned in
  `package.json`, so Volta switches to them inside the repo. Yarn older than 4.17.1 can't install
  TypeScript 7.
- **Optional keys** for reviews and Linear. Add them in the [settings popup](#settings), or in
  the env file `~/.pr-quest/.env`, in the [state directory](#where-state-lives). Start from the
  example:

  ```sh
  mkdir -p -m 700 ~/.pr-quest
  cp .env.example ~/.pr-quest/.env
  chmod 600 ~/.pr-quest/.env
  ```

  PR Quest warns at startup when other users may read that file.

  ```sh
  # Cursor reviews. Create one at https://cursor.com/dashboard/integrations
  CURSOR_API_KEY=...
  # Claude reviews. Create one at https://console.anthropic.com/settings/keys
  ANTHROPIC_API_KEY=...
  # Optional Linear enrichment: review page links and the "needs attention" flag
  LINEAR_API_KEY=...
  # Enables "Sign in with GitHub"; see below
  PR_QUEST_GITHUB_CLIENT_ID=...
  ```

  Without a key for the selected review provider, the board, approvals and XP still work, and
  "Send review agent" says which key is missing, with a button that opens the settings at it.

Other optional settings: `PR_QUEST_PORT` (API, default `4317`), `PR_QUEST_UI_PORT` (UI, default
`4318`) and `PR_QUEST_STATE_DIR` (default `~/.pr-quest`). `PR_QUEST_MODE`, `PR_QUEST_HOST`,
`PR_QUEST_PUBLIC_ORIGIN` and `PR_QUEST_ALLOWED_HOSTS` belong to [hosted mode](#hosted-mode),
which isn't usable yet.

PR Quest reads settings from three places, and the first one that sets a value wins:

1. The environment.
2. The env file in the state directory, `<PR_QUEST_STATE_DIR>/.env`. It can't set
   `PR_QUEST_STATE_DIR` itself, because it is read from there; PR Quest refuses to start if it
   tries.
3. `.env.local` at the repo root (git-ignored), read by `yarn dev` and `yarn start` from a
   checkout. It was the only env file before, so existing setups keep working, and it may set
   `PR_QUEST_STATE_DIR`. Move its other values to `~/.pr-quest/.env` when convenient.

Setting a value to an empty string in the environment or a file ignores the places below it, so
the default applies. For an API key, the default is the key saved in Settings:
`CURSOR_API_KEY= yarn dev` drops the key from the env files, but a Cursor key saved in Settings
still applies. Remove it in Settings to run without one.

## Sign in with GitHub

"Sign in with GitHub" uses GitHub's
[device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow):
PR Quest shows a short code, you enter it at <https://github.com/login/device>, and the server
polls GitHub until you approve. It needs no client secret and no callback, so nothing has to
reach your machine from outside. It does need a GitHub OAuth App, which you create once.

### Create the OAuth App

1. On GitHub, open **Settings**, then **Developer settings**, then **OAuth Apps**, and choose
   **New OAuth App**. To own the app as an organization instead, use the organization's
   **Settings → Developer settings → OAuth Apps**.
2. Fill in the form:
   - **Application name**: for example `PR Quest (local)`. GitHub shows it when you authorize.
   - **Homepage URL**: `http://127.0.0.1:4318`, the default UI port. If you set
     `PR_QUEST_UI_PORT`, use your port instead. GitHub only displays it.
   - **Authorization callback URL**: anything, for example `http://127.0.0.1:4318`. The form
     requires one, but the device flow never uses it.
   - **Enable Device Flow**: checked. Without it, GitHub refuses to issue codes.
3. Choose **Register application** and copy the **Client ID**. You don't need a client secret;
   don't generate one.

### Configure PR Quest

Put the client ID in `~/.pr-quest/.env` (or `.env.local`) and restart PR Quest:

```sh
PR_QUEST_GITHUB_CLIENT_ID=Ov23li...
```

A client ID isn't secret: it only names the app, and every sign-in still needs your approval on
github.com. A team could later commit theirs as the default in `DEFAULT_GITHUB_CLIENT_ID` in
[`src/platform/server/config.ts`](src/platform/server/config.ts), so nobody has to set it.

Without a client ID, the sign-in button and the settings popup explain this setup and link here.

### Scopes

PR Quest asks for `repo read:org`:

- `repo` to read private PRs, their diffs and reviews, and to post reviews and approvals. GitHub
  OAuth Apps have no read-only scope for private repositories, so this grants full access to
  every repo you can access. PR Quest only makes the calls described in
  [How it works](#how-it-works).
- `read:org` to see which team a review request came through.

`repo` is broader than PR Quest needs. A GitHub App would be a better fit later: its
user-to-server tokens can be limited to pull requests, repository contents (read) and
organization members (read), and they expire after 8 hours.

### Organizations with OAuth App access restrictions

Organizations such as Trackunit can restrict which OAuth Apps may access their data. Until an
organization owner approves the app, its token can't see that organization's private repos, so
their PRs don't show up on the board. When you authorize the app, GitHub lists your
organizations with a **Request** button next to each restricted one; you can also request access
later under **Settings → Applications → Authorized OAuth Apps**. An organization owner then
approves it in the organization's settings under **Third-party access → OAuth app policy**.
Until then, keep using the gh fallback: the GitHub CLI is an OAuth App too, and it works wherever
the organization already approved it, as Trackunit has. A signed-in OAuth token wins over gh, so
if you signed in before the approval, **Sign out** to get the organization's PRs back.

### The gh fallback

Without a sign-in, PR Quest uses the token of a logged-in GitHub CLI (`gh auth token`). It reads
the token again at most every 5 minutes, so `gh auth switch` can take that long to show up. When
you have signed in, the OAuth token wins over gh. **Sign out** forgets the OAuth token, and PR
Quest goes back to the gh token if there is one. If that token belongs to a different GitHub
account, PR Quest says so after you sign out. The account chip in the page's top-right corner
shows who PR Quest acts as; its popout shows where the token came from (**OAuth** or **gh CLI**)
and, for OAuth, offers **Sign out**. While nobody is signed in, the chip reads **🔑 Sign in**,
and its popout starts with a **Sign in with GitHub** button.

## The header

The top-right corner of the page holds just two things, so the player box below it shows only
game info (level, XP, streak and achievements):

- **Live** says whether the live updates stream is connected.
- The **account chip** shows your avatar and login, or **🔑 Sign in** while nobody is signed in.
  On narrow screens it shows only the avatar.

The chip opens the account popout. It has the same layout whether you're signed in or not:

1. The account: who PR Quest acts as and the token source, or **Sign in with GitHub**.
2. **Notifications** and **Sound**, each a switch that shows whether it's on. The first time you
   turn notifications on, the browser asks for permission; if you blocked them, the switch is
   off and disabled and says how to allow them again.
3. **Settings**, the only way into the [settings](#settings) from the header.
4. **Sign out**, for OAuth sign-ins.

The account popout and the quest board's presets list are small popovers: they open below their
button and move focus into themselves. `Escape` closes them and returns focus to the button;
clicking or tabbing outside also closes them. Turning a switch leaves the popout open.

Every control that shows only an icon has a tooltip saying what it does: the account chip, the
✕ that closes dialogs, dismisses toasts and deletes presets, and the badges of your recent
achievements. Tooltips show while the mouse hovers or keyboard focus is on the control, and
`Escape` hides them.

## Settings

**Settings** in the account popout opens the settings popup. It has three sections:

- **GitHub account**: who PR Quest acts as and the token source, with sign-in and sign-out.
- **Review provider**: who reviews your quests, and with which model.
- **API keys**: set, replace or remove the Cursor, Claude (Anthropic) and Linear keys.

The popup traps focus and closes on `Escape` or ✕, also after the focused button goes away, for
example when you sign out. While a change is being saved, it stays open and takes one change at a
time. A "Send review agent" error caused by a missing key offers **Open settings**, which opens
the popup with that key's input focused.

**API keys** show only whether each key is set, its last four characters (for keys of 12
characters or more) and its source: `settings` when it was saved from the popup, `env` when it
comes from the environment or an env file. Environment keys win over saved ones and are
read-only in the popup; change them in the env file and restart. Saved keys apply to the next
request without a restart. Removing a key asks for confirmation first. The key values themselves
never leave the server. The key inputs ask 1Password, LastPass and Bitwarden not to save them; a
browser's built-in password manager may still offer to.

Keys belong to this computer, not to a GitHub account: every GitHub account that signs in here
uses the same saved keys, and signing out doesn't remove them. The review provider and models are
shared the same way.

### Review providers and models

- **Cursor** sends a Cursor cloud agent, which checks out the repo and reviews the PR there. It
  needs a Cursor API key.
- **Claude** sends the PR's diff to Anthropic's Messages API. It needs an Anthropic API key and
  never sees the rest of the repo; see [Claude reviews](#claude-reviews).

Each provider has its own model setting. With the provider's key, the list comes from the
provider (Cursor's model list, Anthropic's `GET /v1/models`); without it, or when the provider
can't be reached, the popup shows a built-in fallback list and says so. The list reloads when the
provider's key changes. The default for Cursor is Cursor's own default model; for Claude it is
`claude-sonnet-5-5`. The provider and models are saved in `settings.json`; the result screen
shows which provider and model reviewed each run.

## Run it

```sh
gh repo clone bchTrackunit/pr-quest
cd pr-quest
yarn install
yarn dev
```

`yarn dev` starts the API on <http://127.0.0.1:4317>, restarting it when the server code changes,
and the UI on <http://127.0.0.1:4318> with hot reload. Open the UI in a browser or in Cursor's
browser tab. The UI proxies `/api` to the server and receives live updates over server-sent
events; the indicator in the header shows "Live" when it is connected.

To run the production build instead:

```sh
yarn build
yarn start
```

`yarn build` builds the UI into `dist/` and bundles the server into `dist-server/` with
[esbuild](https://esbuild.github.io). `yarn start` runs `node dist-server/main.js`, which serves
the API and the built UI together on <http://127.0.0.1:4317>; there is no separate UI port. Without
a `dist/` build it serves only the API and says so. The bundle leaves `@cursor/sdk` and
`@anthropic-ai/sdk` out, so it still needs the repo's `node_modules`.

### Hosted mode

`PR_QUEST_MODE` is `local` by default: one player on their own machine, listening on `127.0.0.1`
only. Local mode refuses a `PR_QUEST_HOST` other than `127.0.0.1`, and refuses the hosted-only
settings, so a typo can't expose the server.

`PR_QUEST_MODE=hosted` is groundwork for serving many players from one address. It needs
`PR_QUEST_PUBLIC_ORIGIN`, the origin browsers load PR Quest from (for example
`https://pr-quest.example`), listens on `PR_QUEST_HOST` (default `::`, every interface) and accepts the Host
names in `PR_QUEST_ALLOWED_HOSTS` (comma-separated, default the public origin's host name).
Every player brings their own keys, so hosted mode refuses to start with `CURSOR_API_KEY`,
`ANTHROPIC_API_KEY` or `LINEAR_API_KEY` set, and the server warns when the public origin is plain
`http:` to anything but loopback. Hosted mode also needs a sign-in that tells players apart and storage for each of them, which
don't exist yet, so `yarn start` refuses to start in hosted mode. Code that embeds the server
supplies them through `startServer` in
[`src/app/server/server.ts`](src/app/server/server.ts).

The server checks GitHub every 2 minutes and when you press **Refresh**. Loading the page or
reconnecting the live stream never forces a GitHub call; both use the server's cached list.

## Checks

| Command             | What it does                                                                    |
| ------------------- | ------------------------------------------------------------------------------- |
| `yarn typecheck`    | Type-checks the UI, server and test projects                                    |
| `yarn lint`         | Lints with [oxlint](https://oxc.rs/docs/guide/usage/linter), type-aware         |
| `yarn lint:fix`     | Applies oxlint's safe fixes                                                     |
| `yarn format`       | Formats the repo with [oxfmt](https://oxc.rs/docs/guide/usage/formatter)        |
| `yarn format:check` | Fails if a file isn't formatted                                                 |
| `yarn test`         | Runs the Vitest suite once (`yarn test:watch` keeps it open)                    |
| `yarn build`        | Type-checks, then builds the UI into `dist/` and the server into `dist-server/` |
| `yarn build:server` | Bundles only the server into `dist-server/`                                     |
| `yarn start`        | Runs the production build; see [Run it](#run-it)                                |

With [just](https://just.systems) installed, `just check` runs the type check, lint, format check,
tests and build, as CI does on every pull request and every push to `main`.

oxlint reads `.oxlintrc.json`. Type-aware rules such as `no-floating-promises` run through
`oxlint-tsgolint`. The repo's own rules (no type assertions, no barrel files, no enums and the
[project structure](#project-structure) boundaries) are a small oxlint JS plugin in
`oxlint-plugins/local.js`. oxfmt reads `.oxfmtrc.json`. For editor support, install the
recommended [Oxc extension](https://marketplace.visualstudio.com/items?itemName=oxc.oxc-vscode).

`yarn typecheck` runs TypeScript 7, the native compiler, which ships as the `typescript` package.
It has no `tsserver`, so keep your editor on its bundled TypeScript rather than "Use Workspace
Version".

The UI is built with the [React Compiler](https://react.dev/learn/react-compiler)
(`babel-plugin-react-compiler`, run by `@vitejs/plugin-react`), which memoises components and
hooks. `vite build` prints how many it memoised and lists any it skipped; a skipped component
still works, it just isn't memoised. Vitest reuses `vite.config.ts`, so the jsdom UI tests run
the compiled components. oxlint checks the Rules of React the compiler relies on with its built-in
port of the compiler's lint rules (`react/purity`, `react/refs`, `react/immutability` and the
others listed in `.oxlintrc.json`), and `react/todo` warns about code the compiler can't compile
yet.

## Project structure

Each feature owns its server and UI code. Tests sit next to the code they test.

```text
src/
  app/          composition roots: they wire the features together
    server/     main.ts (production entry), dev.ts (dev entry), server.ts (startServer, for
                embedding), app.ts, the HTTP route tables, identity.ts (who a request acts
                as), storage.ts (where secrets, settings and player state live), per-player
                sessions and state dirs
    ui/         main.tsx (entry), App.tsx, the header controls and preferences, the game
                controller hook and the live event stream
  features/
    auth/       GitHub device flow, token resolution, the GitHub account control
    settings/   API keys, review provider and model settings, the settings dialog
    game/       XP, levels, achievements, streaks, the player state store, HUD, toasts, XP popups
    quests/     GitHub search and GraphQL client, Linear, quest cache and polling, the quest board
    reviews/    review runs, Cursor and Claude reviews, diff budget, review result and approve UI
  platform/
    server/     router and security guards, config, SSE events, GitHub API wrapper, rate limits,
                private files and secrets
    ui/         API client, store, Modal, Popover, Tooltip, formatting and clock helpers,
                notifications, styles
  shared/       the API contract (api.ts) and the review prompt and result schema (reviewResult.ts)
```

Each feature has `server/` and `ui/` folders, and each folder has an `index.ts` that is its public
entry. Server and UI get separate entries so that the UI bundle never pulls in server code.

Dependency rules, enforced by `yarn lint`:

- `src/shared` imports only from `src/shared`.
- `src/platform` imports only from `src/platform` and `src/shared`, never from a feature or
  `src/app`.
- A feature imports its own files, `src/platform` and `src/shared`. It reaches another feature only
  through that feature's `index.ts`, never a deeper file. Tests may also use another feature's
  `test-utils/`.
- Only `src/app` imports from `src/app`, and it also goes through each feature's `index.ts`.
- UI code and server code never import each other; they share only `src/shared`.
- There are no import cycles (`import/no-cycle`). The features form one direction: `reviews`
  uses `quests`, `game` and `settings`; `quests` uses `game` and `settings`; `game` uses
  `settings`; `settings` uses `auth`.

## How it works

PR Quest calls GitHub's REST and GraphQL APIs directly with `fetch` and your token. It runs no
`gh` commands apart from `gh auth token` for the [gh fallback](#the-gh-fallback).

- **Quests** come from a `GET /search/issues` search for `review-requested:@me`, which includes
  team requests. A second search with `user-review-requested:@me` tells direct requests apart.
  Branches, diff stats, draft state, latest reviews and requested teams for every PR come from
  batched GraphQL queries (25 PRs per query). If a batch fails, PR Quest falls back to one query
  per PR, except when the failure is a rate limit. A PR whose details still can't be read is left
  off the board. If that happens to more than half of the PRs the search found, the
  refresh counts as failed: the server logs a warning and keeps serving the previous list, so a
  network problem can't empty the board.
- **Approvals by others** come from each PR's latest reviews. A PR counts as approved by others
  when someone other than you has an `APPROVED` latest review.
- **Linear** is optional. With a Linear key, the server calls Linear's MCP `list_diffs` tool
  to add each PR's Linear review link and `needsAttention` flag. Any Linear failure falls back to
  GitHub data only.
- **Tiers** use additions plus deletions: Trivial under 50 lines, Normal under 400, Hard under
  2,000 lines and 50 files, and Boss above that.
- **Sorting** is described in [Filtering and sorting](#filtering-and-sorting).

## Filtering and sorting

The bar above the quest cards narrows and orders the board. Everything runs in the browser on
the list the server already has, so filtering never calls GitHub.

The bar is one row: the search box, the **Sort** select, the **Presets** dropdown and a
**Filters** button. **Filters** opens a panel with Difficulty, Agent and Hide; the button shows
how many of those are on, and `Escape` or a second click closes the panel. Below the row, a line
shows how many quests match and one chip per active filter.

- **Search** matches the title, author, source branch and PR number. `#123` matches PR 123 in
  any repo, and `repo#123` or `owner/repo#123` matches one repo's PR. Several words must all
  match. Press `/` to jump to the search box, `Escape` to clear it and `Enter` to apply it
  without waiting for the short typing delay.
- **Requests** (All, Direct, Team) are the buttons in the board header. With All, the board is
  grouped into direct and team requests; the other filters and the sort apply inside each group.
- **Difficulty** and **Agent** (in the Filters panel) are multi-select. Agent states are Not
  started, Running (queued or running), Loot ready (findings you haven't posted or discarded yet)
  and Failed. Selecting nothing in a group means "any".
- **Hide** (in the Filters panel) has two on/off switches: **Drafts** and **Approved by others**.
- **Sort**: _Smart_ (the default) puts direct requests first, then PRs that need attention, then
  the longest-waiting. _Smallest first_ and _Largest first_ order by additions plus deletions,
  using changed files as the tie-breaker.

Active filters show as chips you can remove one at a time, or all at once with **Clear all**.
The count says how many quests are shown out of the total. If the filters hide every quest, the
board says so and offers to clear them; this is different from Inbox Zero, which means GitHub
returned no review requests.

The buttons in each filter group support the arrow keys, `Home` and `End`, and every toggle
reports its state to screen readers with `aria-pressed`.

### Presets

**Presets** save the current filters and sort under a name. The **Presets** dropdown lists them
and shows the name of the one that matches the current view. Choosing a preset applies it and
closes the dropdown. Two built-in presets, marked ★, can't be deleted:

| Preset     | Difficulty      | Other settings                                        |
| ---------- | --------------- | ----------------------------------------------------- |
| Quick wins | Trivial, Normal | Hide drafts, hide PRs others approved, smallest first |
| Boss rush  | Hard, Boss      | Largest first                                         |

Choose **Save current…** in the dropdown to add your own (up to 20, names up to 40 characters);
✕ next to one of yours deletes it. Saving under an
existing name replaces that preset. The board remembers your last filters and sort in the
browser's `localStorage` (`pr-quest:board-view:v1`, presets in `pr-quest:presets:v1`). Saved data
that can't be read is ignored and the defaults are used instead.

## GitHub rate limits

GitHub's search API allows 30 searches a minute, and each refresh uses 2. PR Quest avoids
spending them and copes when it runs out anyway:

- **Cache on disk.** The last successful list is saved to `quests.json` in the state directory.
  On startup the server serves it straight away and only asks GitHub again when it is more than
  60 seconds old. The 2-minute poll also skips GitHub while the list is fresh.
- **Detection.** A failed response with `x-ratelimit-remaining: 0`, or an error mentioning "API
  rate limit exceeded", is a primary limit. A `retry-after` header, "secondary rate limit", abuse
  detection and HTTP 429 are secondary limits. A plain HTTP 403 is not treated as a rate limit,
  because GitHub also uses it for missing permissions and SAML.
- **Backoff.** PR Quest waits until the reset time GitHub sent in the failed response's
  `x-ratelimit-reset` or `retry-after` header. Without one, it reads the reset time from
  `GET /rate_limit`, which doesn't count against the limit. When there is still no reset time, it
  waits 60 seconds, doubling on each repeat up to 10 minutes. The backoff is saved with the
  cache, so restarting the server doesn't retry early.
- **During the backoff** the poll, the **Refresh** button and `?refresh=1` don't call GitHub. The
  API returns the cached quests with `stale: true` and `rateLimit: { kind, limitedUntil }`, and
  the server retries once on its own when the backoff ends.
- **In the UI** a calm banner says, for example, "GitHub rate limit reached, showing results
  from 14:02, retrying at 14:03." Refresh is disabled and counts down to the retry. A list older
  than 60 seconds shows "cached" next to the fetch time.

If GitHub limits PR Quest before it has ever fetched a list, there is nothing to show, so the
API returns a `503` with the code `rateLimited` and the board shows that as an error.

### The review agent and its safety limits

With the Cursor provider, "Send review agent" starts a Cursor cloud agent through `@cursor/sdk`,
pinned to the PR's head
commit: the quest's `headSha` is the agent's starting ref, so pushes made after you send it don't
change what it reviews. The repo is always the base repo. The prompt names the exact commit and
tells the agent to check it out from `pull/<number>/head` if it didn't start there, which also
works for PRs from forks. The agent:

- reviews only `git diff origin/<target>...HEAD` at that commit, reading other code just for
  context;
- is told never to commit, push, create branches, open or update a PR, approve or comment;
- returns a JSON report (`summary`, advisory `verdict`, `findings` with file, line, severity and
  body, and `reviewedSha`, the commit it reviewed), which the server validates. If `reviewedSha`
  isn't the commit it was sent to, the run fails instead of offering findings whose line numbers
  may be wrong.

**What the agent can do.** The cloud agent runs with your Cursor identity, through your Cursor
GitHub integration, on PR content that the PR's author controls: the code, the title and the
description. Cloud agents don't accept a system prompt or tool restrictions, so the rules above,
including "never commit" and "never approve", exist only in the prompt. A PR that contains a
prompt injection could talk the agent out of them. The only hard guard is `autoCreatePR: false`,
which stops the SDK from opening a PR for the agent's work. PR Quest also sets
`workOnCurrentBranch: false`, but the SDK doesn't document what that prevents, so don't rely on
it.

### Claude reviews

With the Claude provider, the server reviews the PR's diff, never the repo:

- **The diff is pinned to the quest's head commit.** It comes from GitHub's compare API
  (`<target>...<headSha>`), which shows the same changes as the PR. If that fails, PR Quest uses
  the PR's own diff, but only while the PR's head is still that commit.
- **Files are left out before the diff is sent.** Lockfiles (such as `yarn.lock` and
  `package-lock.json`), generated files (`dist/`, `build/` and `out/` at the repo root, `vendor/`
  and `node_modules/` anywhere, snapshots, `*.min.js`, source maps and similar) and binary files
  are dropped. The rest are kept in order while they fit in about 280,000 characters. If
  Anthropic still says the prompt is too long, the run fails with that message and isn't retried. A file that doesn't fit is left out as too
  large, but smaller files after it still get in. If nothing is left, the review fails without
  calling Anthropic.
- **Claude is told what it can't see.** The prompt lists up to 200 omitted files by name and
  reason, as escaped strings so a file name can't add lines to the prompt, then says how many more
  there are. The result screen shows all of them under **Omitted files**, and a posted review
  lists up to 50.
- **PR content is treated as data.** The title, branches and diff sit between delimiters with a
  random nonce, and the system prompt says never to follow instructions inside them and to report
  attempts to steer the reviewer as a security finding.
- **The answer is a forced tool call.** The request offers one tool, `submit_review`, and makes
  Claude call it. The server validates its input as the same report the Cursor agent returns,
  with up to 16,000 output tokens. A refusal, a truncated answer or invalid output fails the run.

**What Claude can do.** Nothing outside its answer. The Claude provider can't run code, read the
repo or write anywhere: the request has no tools that act, `submit_review` is only read by PR
Quest, and nothing Claude returns reaches GitHub until you choose **Post to PR**. A prompt
injection in the diff can still make the review itself wrong or misleading, so read the findings
as advice. The diff, title and branch names are sent to Anthropic under your API key.

### What PR Quest does with the findings

**What PR Quest itself does.** PR Quest never turns agent output into an approval. The verdict is
shown as advice only, the post endpoint accepts only `comment` and `requestChanges`, and the only
approve path is the **Approve** dialog. Findings appear on a result screen first, and nothing
reaches GitHub until you choose **Post to PR** and confirm.

**Accepting and rejecting findings.** Every finding starts undecided. Each finding card has a
✓ **Accept** and a ✕ **Reject** toggle; pressing the one that's on makes the finding undecided
again. **Accept all**, **Reject all** and **Reset** decide on every finding at once, and a line
such as "3 accepted · 1 rejected · 2 undecided" keeps count. Accepted findings get a green edge;
rejected ones are dimmed and struck through, and **Hide rejected** takes them off the screen. The
toggles are ordinary buttons that report their state with `aria-pressed`, and each has a tooltip.
Decisions are saved on the server with the run as you make them (`PUT /api/runs/:id/decisions`),
so they survive a page reload and a server restart, and other open tabs see them through the live
updates stream. Once a run is posted, its decisions are shown but can't change. Deciding earns no
XP and costs none.

**Posting.** Only accepted findings are posted; rejected and undecided findings never are, and the
summary always is. The confirmation says what will go out, for example "Posting 3 of 6 findings in
one GitHub review: 2 as inline comments and 1 in the review body. 1 rejected and 2 undecided won't
be posted." With nothing accepted, it says the review will hold only the summary, and you can
still post it. The server enforces this rather than trusting the page: the post request names the
accepted findings you confirmed, and the server posts the findings its saved decisions accept,
refusing with `409` if the two differ (for example because another tab changed a decision) and
with `400` for a finding the review doesn't have or for a request that names no findings at all.
A finding's id is its position in the review's findings, which never changes once the review has
finished.

The confirmation always starts at **Comment**; when the agent suggests requesting changes, it says
so next to the choice but never picks it for you. That posts one GitHub review (comment or request
changes) anchored to the same commit the agent reviewed, with inline comments for accepted
findings that have a line. If GitHub rejects the inline line numbers, it posts them in the review
body instead. The omitted files are still listed, the footer names the provider and model that
wrote the review, and `@user` or `@org/team` in the model's text is wrapped in backticks so
posting never pings anyone. Posting earns the same XP however many findings it includes.

**Approve** is a separate action with its own confirmation dialog, which names the PR and the
short head commit you're approving. The approval is pinned to that commit: the server reads the
PR's current head with `GET /repos/<owner>/<repo>/pulls/<number>` first, and if new commits were
pushed, it approves nothing and answers `409 headChanged`. The dialog then says "New commits were
pushed to this PR. Re-check them before approving." and shows the new commit. Otherwise it
approves through `POST /repos/<owner>/<repo>/pulls/<number>/reviews` with `event: APPROVE` and
`commit_id` set to that commit. Draft PRs can't be approved.

Runs are saved, so a server restart reattaches to a Cursor run that was still going. A Claude
review is a single request, so a restart during one marks it as failed.

### Local server protections

The API acts as you, so it only accepts requests that come from PR Quest:

- **Host** must be `127.0.0.1` or `localhost`, which stops DNS rebinding.
- **Origin**, when the browser sends one, must be exactly the server's own origin,
  `http://127.0.0.1:<port>` or `http://localhost:<port>` for `PR_QUEST_PORT`. Under `yarn dev` the
  UI's origin on `PR_QUEST_UI_PORT` is trusted too, because Vite proxies `/api` from there;
  `yarn start` serves the UI itself and doesn't trust that port. Pages on other localhost ports,
  such as another dev server, get `403`.
- **`Sec-Fetch-Site`**, when the browser sends it, must be `same-origin` or `none` on every
  request, including GETs, so an image or script tag on another page can't trigger a call.
  Browsers send `same-site` for other localhost ports, so this is checked as well as the origin.
- **Every POST, PUT and DELETE must be `Content-Type: application/json`**, or the server answers
  `415`. A browser can't send JSON to another origin without a CORS preflight, which the server
  never grants.

When `yarn start` serves the built UI, page and asset requests outside `/api` get only the Host
check, so links and bookmarks still open the page. Only GET and HEAD are served, from `dist/`
alone: paths with `..`, a backslash or a dotfile segment get `404`. A path without a file
extension that isn't a file gets `index.html`, so the app's own routes load. Hashed files under
`assets/` are cached for a year as `immutable`; `index.html` and the rest are `no-cache`, so a new
build shows up on the next load.

In [hosted mode](#hosted-mode) the Host must be one of `PR_QUEST_ALLOWED_HOSTS` and the Origin
must be `PR_QUEST_PUBLIC_ORIGIN`. `GET /api/health` skips the Host check there, so a load
balancer can probe it by IP address; its other checks still apply. It answers only
`{ "ok": true }` there, without the configuration local mode reports.

## XP and achievements

XP is awarded only for real review actions, never for just starting an agent:

| Action          | Base XP |
| --------------- | ------- |
| Post a review   | 20      |
| Approve         | 15      |
| Request changes | 15      |

Base XP is multiplied by tier: Trivial ×1, Normal ×1.5, Hard ×2, Boss ×3. Approving the same PR
twice earns XP once. The XP needed for the next level is `100 × level^1.5`. The streak counts
consecutive local calendar days with at least one rewarded action.

Inbox Zero counts only what GitHub's search returns. Hiding a quest you just approved doesn't
count as an empty queue, and neither does a refresh where most PR details couldn't be read.

Unlocking an achievement adds bonus XP by rarity, and the bonus can level you up:

| Rarity    | Bonus XP |
| --------- | -------- |
| Common    | 25       |
| Rare      | 50       |
| Epic      | 100      |
| Legendary | 200      |

Each achievement pays its bonus once. Achievements unlocked before bonuses existed don't pay
retroactively. "Review action" below means posting a review, requesting changes or approving;
starting or finishing an agent counts only where it says so. Times and days use the server's
local clock.

| Achievement      | How to unlock                                                                 | Rarity    |
| ---------------- | ----------------------------------------------------------------------------- | --------- |
| **Milestones**   |                                                                               |           |
| First Blood      | Your first review action                                                      | Common    |
| Centurion Bronze | 10 review actions                                                             | Common    |
| Centurion Silver | 50 review actions                                                             | Rare      |
| Centurion Gold   | 100 review actions                                                            | Legendary |
| Team Player      | 10 review actions on team-requested PRs                                       | Rare      |
| Agent Commander  | 10 finished agent reviews                                                     | Rare      |
| Gatekeeper       | Request changes on 5 different PRs                                            | Rare      |
| Giant Killer     | Approve 5 Boss-tier PRs                                                       | Epic      |
| **Streaks**      |                                                                               |           |
| On Fire          | A 5-day streak                                                                | Epic      |
| Unstoppable      | A 7-day streak                                                                | Legendary |
| Early Bird       | A review action before 08:00                                                  | Common    |
| Night Owl        | A review action at 22:00 or later                                             | Common    |
| Weekend Warrior  | A review action on a Saturday or Sunday                                       | Common    |
| **Feats**        |                                                                               |           |
| Quick Draw       | Approve within an hour of the review request                                  | Rare      |
| Boss Slayer      | Post a review on, or approve, a Boss-tier PR                                  | Rare      |
| Inbox Zero       | GitHub finds no review requests on a day you reviewed something               | Rare      |
| Clean Sweep      | Act on 5 direct requests in a day, and leave no direct request on the board   | Epic      |
| Necromancer      | A review action on a PR requested 30 days or more ago                         | Rare      |
| The Long Read    | A review action on a PR with 2,000 or more changed lines                      | Rare      |
| Eagle Eye        | Post a review with at least one accepted critical or major finding            | Common    |
| Featherweight    | Approve 10 Trivial PRs in a day, each after a posted review or finished agent | Rare      |
| Second Opinion   | A finished Claude review and a finished Cursor review on the same PR          | Rare      |
| **Variety**      |                                                                               |           |
| Explorer         | Review actions in 10 different repos                                          | Rare      |
| Diplomat         | Review actions on PRs from 10 different people, not counting yourself or bots | Rare      |
| Bot Wrangler     | Review actions on 10 PRs by Dependabot or Renovate                            | Rare      |
| **Secret**       |                                                                               |           |
| Speedrunner      | Approve within 5 minutes of the request, after a posted review or agent run   | Epic      |
| Archaeologist    | A review action on the quest that has waited longest on your board            | Rare      |

The Achievements dialog shows the secret ones as "???" with a hint until they unlock, and shows
progress where there is a count, such as Explorer 3/10 or Centurion 12/50 toward Silver. Daily
counts (Clean Sweep, Featherweight) start again at local midnight.

Achievements are defined in
[`src/features/game/server/achievements.ts`](src/features/game/server/achievements.ts); the UI
renders whatever that file lists.

### Progress from before these achievements

State from an older PR Quest keeps its XP, level, counters, streak and unlocked achievements.
Some progress is rebuilt from what was already stored:

- Centurion, Team Player and Agent Commander use the existing counters.
- Explorer counts repos from rewarded approvals and posted reviews.
- Giant Killer counts approved PRs whose stored review run was Boss-tier.
- Eagle Eye counts posted reviews that had a critical or major finding.
- Second Opinion uses the finished Claude and Cursor runs still in the run history.

Anything rebuilt this way unlocks, with its bonus, at the next game event, such as the next
queue check. Diplomat, Bot Wrangler, Gatekeeper, the daily counts and the time-of-day, weekday,
wait-time and board achievements need details older state never stored, so they count only
actions from now on.

## Where state lives

Everything is under `~/.pr-quest` (or `PR_QUEST_STATE_DIR`). Directories are created with mode
`0700` and files are written atomically with mode `0600`:

```text
~/.pr-quest/
├── .env                optional settings and keys that you write; PR Quest only reads it
├── secrets.json        the GitHub OAuth token and the API keys saved from Settings
├── settings.json       the review provider and the model per provider
└── users/
    └── <login>/        one folder per GitHub user, named by the lower-cased login
        ├── state.json  XP, counters, streak, achievements, the last 200 review runs and
        │               their finding decisions
        └── quests.json the last quest list, when it was fetched, any rate-limit backoff
```

`secrets.json` and `settings.json` are shared; the game and the quest cache belong to whoever
the current token is. Signing in as someone else opens their own folder, starting fresh. Keys
set in the environment or an env file are never written to `secrets.json`.

An unreadable `state.json` or `secrets.json` is moved aside as `<file>.corrupt-<time>`, and PR
Quest starts without it. Unreadable finding decisions on a run are the exception: they are
dropped, which leaves that run's findings undecided, and the rest of `state.json` is kept. An unreadable `settings.json` is replaced with the defaults (Cursor
reviews, default models) without a copy, and the next settings change overwrites it. An
unreadable `quests.json` is ignored and replaced on the next successful fetch. A `secrets.json`
or `settings.json` written by a newer PR Quest stops the server at startup with a message, so
an older build never drops or overwrites it. A `state.json` from a newer PR Quest is left in place,
and the game reports an error saying so instead of loading it. The first time PR Quest reads a version 1 `state.json`, it copies it
to `state.json.v1.bak` before anything is written; an existing backup is never overwritten, and
nothing reads it again. Copy it back over `state.json` to run an older build. Delete a user's folder to reset their progress. Board filters and presets live
in the browser, as described in [Presets](#presets).

### Moving the old state into a user's folder

Before per-user folders, `state.json` and `quests.json` sat directly in `~/.pr-quest`. The first
GitHub user PR Quest sees gets them: each file is copied into `users/<login>/`, then the original
is renamed to `<file>.migrated-to-<login>-<UTC time>.bak`, for example
`state.json.migrated-to-octocat-20261031T091500Z.bak`. Nothing reads the `.bak` files, so the
old state can't be handed to a second user; delete them once you've checked your XP. A user who
already has a `state.json` keeps it. The login that gets the old state is recorded in
`users/.legacy-owner` before anything is copied, so an interrupted migration is finished for that
login on the next start and never handed to someone else. The server logs which files it moved.
If a `state.json` or `quests.json` shows up in `~/.pr-quest` again later,
it is renamed to `<file>.orphaned-<UTC time>.bak` with a warning instead of being given to
anyone.

## Security notes

- **Loopback only.** In local mode, the default, the server listens on `127.0.0.1` and checks
  Host, Origin, `Sec-Fetch-Site` and the content type of every POST, PUT and DELETE, as described
  in [Local server protections](#local-server-protections).
- **Secrets stay in the server process.** The UI only learns whether a key is set, its source and
  its last four characters. No route returns a key or the GitHub token, and the server doesn't
  log them. `gh auth token`, the only command PR Quest runs, gets an environment without
  `CURSOR_API_KEY`, `ANTHROPIC_API_KEY` and `LINEAR_API_KEY`.
- **Secrets are stored in plain text.** `secrets.json` is protected by its `0600` mode and the
  `0700` directory, not encrypted or kept in the macOS keychain. Backups of your home folder
  include it.
- **The OAuth token is broad.** The `repo` scope grants access to every repo you can access (see
  [Scopes](#scopes)); moving to a GitHub App with narrower, expiring tokens is a possible
  improvement. **Sign out** deletes the token from `secrets.json` but doesn't revoke it on
  GitHub; revoke it at <https://github.com/settings/applications> (**Authorized OAuth Apps**)
  when you're done.
- **API keys are per computer.** Every GitHub account that signs in on this machine uses the
  keys saved in Settings, and signing out leaves them in place.
- **Sign-in needs no secret.** The device flow uses only the client ID; the device code stays in
  the server, and no callback reaches your machine.
- **Reviewers see PR content.** The Cursor agent runs in Cursor's cloud with access to the repo
  through your Cursor GitHub integration, and its rules are prompt-only (see
  [The review agent and its safety limits](#the-review-agent-and-its-safety-limits)). Claude gets
  the diff, title and branch names under your Anthropic key, and can't act (see
  [Claude reviews](#claude-reviews)). Neither can approve; only the **Approve** dialog can.

## Privacy

PR Quest has no server of its own and collects nothing. It sends your data only to the services
you use it with, under your own accounts and keys:

- **GitHub** gets the API calls described in [How it works](#how-it-works), made with your token.
- **Cursor** gets the PR to review when you send a Cursor review agent, under your Cursor API key.
  The agent reads the repo through your Cursor GitHub integration.
- **Anthropic** gets the PR's diff, title and branch names when you send a Claude review, under
  your Anthropic API key.
- **Linear** gets a request for your pending reviews, under your Linear API key, if you set one.

Nothing goes to the author of PR Quest: there is no telemetry, analytics or crash reporting. Each
provider's own terms and privacy policy cover what it does with what it receives. Your state,
settings and saved keys stay in the [state directory](#where-state-lives) on your machine.

## Known limitations

- **`requestedAt` is the PR's open time.** GitHub search doesn't return when you were asked to
  review, so "Waiting" and Quick Draw count from when the PR was opened. Quick Draw is
  therefore harder to get than intended.
- **`requestedTeams` lists every team** requested on the PR, not only teams you belong to.
- **The Linear path is unverified with a personal API key.** The MCP endpoint takes a Bearer
  token, but whether it accepts a personal Linear key hasn't been tested. Linear's public
  GraphQL API has no review list or approve mutation (see [the spike](docs/spike.md)), so
  approving always goes through GitHub's API.
- **Refreshing takes about 5 seconds** for around 50 PRs: about 2 seconds of GitHub search and
  2–3 seconds of batched GraphQL.
- **Secondary rate limits without `retry-after` have no reset time**, so they always use the
  exponential backoff.
- **"Approved by others" reads at most 100 latest reviews** per PR.
- **The Cursor fallback model ids are unverified.** Without a Cursor key, the model list is
  PR Quest's built-in guess; with a key, it comes from Cursor.
- **Switching GitHub users stops that user's running reviews.** Each signed-in session uses only
  its own token. If the active user changes while a review runs, for example through
  **Sign out** or `gh auth switch`, the rest of that run's GitHub calls, such as reading a Claude
  diff, fail instead of going out as the new user.
- **Sign out doesn't revoke the token** on GitHub; see [Security notes](#security-notes).
- **Posted agent runs match no Agent filter.** Once findings are posted, the agent state no
  longer applies, so selecting any Agent state hides that PR.
- **The agent's limits are prompt-only**, as described in
  [The review agent and its safety limits](#the-review-agent-and-its-safety-limits).
- **Starting the agent on a commit SHA is untested against the live Cursor API.** The SDK types
  allow any `startingRef`, but they don't say whether a SHA is accepted. If the agent starts
  elsewhere, the prompt has it check out the commit, and a mismatched `reviewedSha` fails the run.
- **Approving costs one extra GitHub call** to re-check the head commit.

## License

PR Quest is released under the [MIT License](LICENSE).
