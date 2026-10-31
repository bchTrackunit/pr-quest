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
- **Node and Yarn through [Volta](https://volta.sh)**. Node 24.22.1 and Yarn 4.13.0 are pinned in
  `package.json`, so Volta switches to them inside the repo.
- **Optional keys** for reviews and Linear. Add them in the [settings popup](#settings), or in
  `.env.local` at the repo root (git-ignored). Start from the example:

  ```sh
  cp .env.example .env.local
  chmod 600 .env.local
  ```

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
`4318`) and `PR_QUEST_STATE_DIR` (default `~/.pr-quest`). They can go in `.env.local` or the
environment. Environment variables take precedence over the file, and setting one to an empty
value ignores both, so the default applies. For an API key, the default is the key saved in
Settings: `CURSOR_API_KEY= yarn start` drops the key from the environment and `.env.local`, but a
Cursor key saved in Settings still applies. Remove it in Settings to run without one.

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

Put the client ID in `.env.local` and restart PR Quest:

```sh
PR_QUEST_GITHUB_CLIENT_ID=Ov23li...
```

A client ID isn't secret: it only names the app, and every sign-in still needs your approval on
github.com. A team could later commit theirs as the default in `DEFAULT_GITHUB_CLIENT_ID` in
[`src/server/config.ts`](src/server/config.ts), so nobody has to set it.

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
account, PR Quest says so after you sign out. The HUD shows who PR Quest acts as and where the
token came from: **OAuth** or **gh CLI**.

## Settings

The ⚙️ button in the HUD opens the settings popup. It has three sections:

- **GitHub account**: who PR Quest acts as and the token source, with sign-in and sign-out.
- **Review provider**: who reviews your quests, and with which model.
- **API keys**: set, replace or remove the Cursor, Claude (Anthropic) and Linear keys.

The popup traps focus and closes on `Escape` or ✕, also after the focused button goes away, for
example when you sign out. While a change is being saved, it stays open and takes one change at a
time. A "Send review agent" error caused by a missing key offers **Open settings**, which opens
the popup with that key's input focused.

**API keys** show only whether each key is set, its last four characters (for keys of 12
characters or more) and its source: `settings` when it was saved from the popup, `env` when it
comes from the environment or `.env.local`. Environment keys win over saved ones and are
read-only in the popup; change them in `.env.local` and restart. Saved keys apply to the next
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
and the UI on <http://127.0.0.1:4318>. `yarn start` does the same without restarting the API on
changes. Open the UI in a browser or in Cursor's browser tab. The UI proxies `/api` to the server
and receives live updates over server-sent events; the indicator in the HUD shows "Live" when it
is connected.

The server checks GitHub every 2 minutes and when you press **Refresh**. Loading the page or
reconnecting the live stream never forces a GitHub call; both use the server's cached list.

## Checks

| Command          | What it does                                                 |
| ---------------- | ------------------------------------------------------------ |
| `yarn typecheck` | Type-checks the UI, server and test projects                 |
| `yarn lint`      | ESLint with typescript-eslint and the React hooks rules      |
| `yarn test`      | Runs the Vitest suite once (`yarn test:watch` keeps it open) |
| `yarn build`     | Type-checks, then builds the UI into `dist/`                 |

With [just](https://just.systems) installed, `just check` runs all four, as CI does on every pull
request and every push to `main`.

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

The panel above the quest cards narrows and orders the board. Everything runs in the browser on
the list the server already has, so filtering never calls GitHub.

- **Search** matches the title, author, source branch and PR number. `#123` matches PR 123 in
  any repo, and `repo#123` or `owner/repo#123` matches one repo's PR. Several words must all
  match. Press `/` to jump to the search box, `Escape` to clear it and `Enter` to apply it
  without waiting for the short typing delay.
- **Requests** (All, Direct, Team) are the buttons in the board header. With All, the board is
  grouped into direct and team requests; the other filters and the sort apply inside each group.
- **Difficulty** and **Agent** are multi-select. Agent states are Not started, Running (queued or
  running), Loot ready (findings you haven't posted or discarded yet) and Failed. Selecting
  nothing in a group means "any".
- **Hide drafts** and **Hide PRs others approved** are on/off switches.
- **Sort**: _Smart_ (the default) puts direct requests first, then PRs that need attention, then
  the longest-waiting. _Size_ orders by additions plus deletions, using changed files as the
  tie-breaker, smallest or largest first.

Active filters show as chips you can remove one at a time, or all at once with **Clear all**.
The count line says how many quests are shown out of the total. If the filters hide every
quest, the board says so and offers to clear them; this is different from Inbox Zero, which
means GitHub returned no review requests.

The buttons in each group support the arrow keys, `Home` and `End`, and every toggle reports its
state to screen readers with `aria-pressed`.

### Presets

**Presets** save the current filters and sort under a name. Two built-in presets, marked ★,
can't be deleted:

| Preset     | Difficulty      | Other settings                                        |
| ---------- | --------------- | ----------------------------------------------------- |
| Quick wins | Trivial, Normal | Hide drafts, hide PRs others approved, smallest first |
| Boss rush  | Hard, Boss      | Largest first                                         |

Choose **Save current…** to add your own (up to 20, names up to 40 characters). Saving under an
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
  `package-lock.json`), generated files (`dist/`, `build/`, `vendor/`, snapshots, `*.min.js`,
  source maps and similar) and binary files are dropped. The rest are kept in order while they fit
  in about 420,000 characters (roughly 120k tokens). A file that doesn't fit is left out as too
  large, but smaller files after it still get in. If nothing is left, the review fails without
  calling Anthropic.
- **Claude is told what it can't see.** The prompt lists the omitted files by name and reason,
  and the result screen shows them under **Omitted files**.
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
reaches GitHub until you choose **Post to PR** and confirm. The confirmation always starts at
**Comment**; when the agent suggests requesting changes, it says so next to the choice but never
picks it for you. That posts one GitHub review (comment or request changes) anchored to the same
commit the agent reviewed, with inline comments for
findings that have a line. If GitHub rejects the inline line numbers, it posts them in the review
body instead.

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
- **Origin**, when the browser sends one, must be exactly the UI or API origin:
  `http://127.0.0.1:<port>` or `http://localhost:<port>` for `PR_QUEST_UI_PORT` and
  `PR_QUEST_PORT`. Pages on other localhost ports, such as another dev server, get `403`.
- **`Sec-Fetch-Site`** on every POST, PUT and DELETE must be `same-origin` or `none`. Browsers
  send `same-site` for other localhost ports, so this is checked as well as the origin.
- **Every POST, PUT and DELETE must be `Content-Type: application/json`**, or the server answers
  `415`. A browser can't send JSON to another origin without a CORS preflight, which the server
  never grants.

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

| Achievement     | How to unlock                                                   | Bonus XP |
| --------------- | --------------------------------------------------------------- | -------- |
| First Blood     | Your first post, request for changes or approval                | 10       |
| Quick Draw      | Approve within an hour of the review request                    | 25       |
| Boss Slayer     | Review or approve a Boss-tier PR                                | 50       |
| Team Player     | 10 review actions on team-requested PRs                         | 40       |
| Inbox Zero      | GitHub finds no review requests on a day you reviewed something | 30       |
| On Fire         | A 5-day streak                                                  | 75       |
| Agent Commander | 10 finished agent reviews                                       | 40       |

Achievements are defined in [`src/server/achievements.ts`](src/server/achievements.ts); the UI
renders whatever that file lists.

## Where state lives

Everything is under `~/.pr-quest` (or `PR_QUEST_STATE_DIR`). Directories are created with mode
`0700` and files are written atomically with mode `0600`:

```text
~/.pr-quest/
├── secrets.json        the GitHub OAuth token and the API keys saved from Settings
├── settings.json       the review provider and the model per provider
└── users/
    └── <login>/        one folder per GitHub user, named by the lower-cased login
        ├── state.json  XP, counters, streak, achievements, the last 200 review runs
        └── quests.json the last quest list, when it was fetched, any rate-limit backoff
```

`secrets.json` and `settings.json` are shared; the game and the quest cache belong to whoever
the current token is. Signing in as someone else opens their own folder, starting fresh. Keys
set in the environment or `.env.local` are never written to `secrets.json`.

An unreadable `state.json` or `secrets.json` is moved aside as `<file>.corrupt-<time>`, and PR
Quest starts without it. An unreadable `settings.json` is replaced with the defaults (Cursor
reviews, default models) without a copy, and the next settings change overwrites it. An
unreadable `quests.json` is ignored and replaced on the next successful fetch. Delete a user's folder to reset their progress. Board filters and presets live
in the browser, as described in [Presets](#presets).

### Moving the old state into a user's folder

Before per-user folders, `state.json` and `quests.json` sat directly in `~/.pr-quest`. The first
GitHub user PR Quest sees gets them: each file is copied into `users/<login>/`, then the original
is renamed to `<file>.migrated-to-<login>-<UTC time>.bak`, for example
`state.json.migrated-to-octocat-20261031T091500Z.bak`. Nothing reads the `.bak` files, so the
old state can't be handed to a second user; delete them once you've checked your XP. A user who
already has a `state.json` keeps it. An interrupted migration is finished on the next start, and
the server logs which files it moved.

## Security notes

- **Loopback only.** The server listens on `127.0.0.1` and checks Host, Origin, `Sec-Fetch-Site`
  and the content type of every POST, PUT and DELETE, as described in
  [Local server protections](#local-server-protections).
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
- **Posted reviews don't list the files Claude omitted.** The result screen shows them, but the
  review posted to GitHub doesn't say which files Claude never saw.
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
