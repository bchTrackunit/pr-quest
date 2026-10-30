# PR Quest

PR Quest is a small local web app that turns the pull requests you've been asked to review into
quests. Each open review request becomes a card with a difficulty tier based on its diff size.
From a card you can send a Cursor cloud agent to review the PR, read its findings, post them to
GitHub, or approve the PR. Real review actions earn XP, levels, a daily streak and achievements.

The board and server run on your machine; only the review agent runs in Cursor's cloud. The
server binds to `127.0.0.1` only, because it acts as you through your `gh` login. It also accepts
browser requests only from its own UI and API origins, as described in
[Local server protections](#local-server-protections).

## Prerequisites

- **GitHub CLI**, logged in: `gh auth login`. PR Quest lists, approves and posts reviews as the
  `gh` user. Check it with `gh auth status`.
- **Node and Yarn through [Volta](https://volta.sh)**. Node 24.22.1 and Yarn 4.13.0 are pinned in
  `package.json`, so Volta switches to them inside the repo.
- **Optional keys** in `.env.local` at the repo root (git-ignored). Start from the example:

  ```sh
  cp .env.example .env.local
  chmod 600 .env.local
  ```

  ```sh
  # Enables "Send review agent". Create one at https://cursor.com/dashboard/integrations
  CURSOR_API_KEY=...
  # Optional Linear enrichment: review page links and the "needs attention" flag
  LINEAR_API_KEY=...
  ```

  Without `CURSOR_API_KEY` the board, approvals and XP still work, and "Send review agent" shows
  a message that the key is missing. PR Quest doesn't pass either key on to `gh`.

Other optional settings: `PR_QUEST_PORT` (API, default `4317`), `PR_QUEST_UI_PORT` (UI, default
`4318`) and `PR_QUEST_STATE_DIR` (default `~/.pr-quest`). They can go in `.env.local` or the
environment. Environment variables take precedence over the file, and setting one to an empty
value turns it off, so `CURSOR_API_KEY= yarn start` runs without the key.

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

- **Quests** come from `gh search prs --review-requested=@me`, which includes team requests. A
  second search with `user-review-requested:@me` tells direct requests apart. Branches, diff
  stats, draft state, latest reviews and requested teams for every PR come from batched
  `gh api graphql` queries (25 PRs per query). If a batch fails, PR Quest falls back to one
  `gh pr view` per PR, except when the failure is a rate limit. A PR whose details still can't be
  read is left off the board. If that happens to more than half of the PRs the search found, the
  refresh counts as failed: the server logs a warning and keeps serving the previous list, so a
  network problem can't empty the board.
- **Approvals by others** come from each PR's latest reviews. A PR counts as approved by others
  when someone other than you has an `APPROVED` latest review.
- **Linear** is optional. With `LINEAR_API_KEY`, the server calls Linear's MCP `list_diffs` tool
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
- **Detection.** A `gh` error mentioning "API rate limit exceeded" is a primary limit. "Secondary
  rate limit", abuse detection and HTTP 429 are secondary limits. A plain HTTP 403 is not treated
  as a rate limit, because GitHub also uses it for missing permissions and SAML.
- **Backoff.** For a primary limit, PR Quest reads the reset time from `gh api rate_limit` (which
  doesn't count against the limit) and waits until then. Without a reset time, and for secondary
  limits, it waits 60 seconds, doubling on each repeat up to 10 minutes. The backoff is saved
  with the cache, so restarting the server doesn't retry early.
- **During the backoff** the poll, the **Refresh** button and `?refresh=1` don't call GitHub. The
  API returns the cached quests with `stale: true` and `rateLimit: { kind, limitedUntil }`, and
  the server retries once on its own when the backoff ends.
- **In the UI** a calm banner says, for example, "GitHub rate limit reached, showing results
  from 14:02, retrying at 14:03." Refresh is disabled and counts down to the retry. A list older
  than 60 seconds shows "cached" next to the fetch time.

If GitHub limits PR Quest before it has ever fetched a list, there is nothing to show, so the
API returns a `503` with the code `rateLimited` and the board shows that as an error.

### The review agent and its safety limits

"Send review agent" starts a Cursor cloud agent through `@cursor/sdk`, pinned to the PR's head
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

**What PR Quest itself does.** PR Quest never turns agent output into an approval. The verdict is
shown as advice only, the post endpoint accepts only `comment` and `requestChanges`, and the only
approve path is the **Approve** dialog. Findings appear on a result screen first, and nothing
reaches GitHub until you choose **Post to PR** and confirm. That posts one GitHub review (comment
or request changes) anchored to the same commit the agent reviewed, with inline comments for
findings that have a line. If GitHub rejects the inline line numbers, it posts them in the review
body instead.

**Approve** is a separate action with its own confirmation dialog, which names the PR and the
short head commit you're approving. The approval is pinned to that commit: the server reads the
PR's current head with `gh pr view` first, and if new commits were pushed, it approves nothing
and answers `409 headChanged`. The dialog then says "New commits were pushed to this PR. Re-check
them before approving." and shows the new commit. Otherwise it approves through
`gh api -X POST repos/<owner>/<repo>/pulls/<number>/reviews` with `event: APPROVE` and
`commit_id` set to that commit, sending your comment as JSON on stdin. Draft PRs can't be
approved.

Runs are saved, so a server restart reattaches to a run that was still going.

### Local server protections

The API acts as you, so it only accepts requests that come from PR Quest:

- **Host** must be `127.0.0.1` or `localhost`, which stops DNS rebinding.
- **Origin**, when the browser sends one, must be exactly the UI or API origin:
  `http://127.0.0.1:<port>` or `http://localhost:<port>` for `PR_QUEST_UI_PORT` and
  `PR_QUEST_PORT`. Pages on other localhost ports, such as another dev server, get `403`.
- **`Sec-Fetch-Site`** on a POST must be `same-origin` or `none`. Browsers send `same-site` for
  other localhost ports, so this is checked as well as the origin.
- **Every POST must be `Content-Type: application/json`**, or the server answers `415`. A browser
  can't send JSON to another origin without a CORS preflight, which the server never grants.

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

Everything is in `~/.pr-quest/state.json` (or `PR_QUEST_STATE_DIR`): XP, counters, streak,
achievements and the last 200 review runs with their findings. The file is written atomically
with mode `0600`. A file that can't be read is moved aside as `state.json.corrupt-<time>`, and
PR Quest starts fresh. Delete the directory to reset your progress.

The same directory holds `quests.json`: the last quest list, when it was fetched and any active
rate-limit backoff. It is also written atomically with mode `0600`, and an unreadable file is
ignored and replaced on the next successful fetch. Board filters and presets live in the
browser, as described in [Presets](#presets).

## Known limitations

- **`requestedAt` is the PR's open time.** GitHub search doesn't return when you were asked to
  review, so "Waiting" and Quick Draw count from when the PR was opened. Quick Draw is
  therefore harder to get than intended.
- **`requestedTeams` lists every team** requested on the PR, not only teams you belong to.
- **The Linear path is unverified with a personal API key.** The MCP endpoint takes a Bearer
  token, but whether it accepts a personal `LINEAR_API_KEY` hasn't been tested. Linear's public
  GraphQL API has no review list or approve mutation (see [the spike](docs/spike.md)), so
  approving always goes through `gh`.
- **Refreshing takes about 5 seconds** for around 50 PRs: about 2 seconds of GitHub search and
  2–3 seconds of batched GraphQL.
- **Rate-limit reset times come from `gh api rate_limit`, not response headers**, because `gh`
  doesn't expose the headers of a failed call. Secondary limits have no reset time, so they
  always use the exponential backoff.
- **"Approved by others" reads at most 100 latest reviews** per PR.
- **Posted agent runs match no Agent filter.** Once findings are posted, the agent state no
  longer applies, so selecting any Agent state hides that PR.
- **The agent's limits are prompt-only**, as described in
  [The review agent and its safety limits](#the-review-agent-and-its-safety-limits).
- **Starting the agent on a commit SHA is untested against the live Cursor API.** The SDK types
  allow any `startingRef`, but they don't say whether a SHA is accepted. If the agent starts
  elsewhere, the prompt has it check out the commit, and a mismatched `reviewedSha` fails the run.
- **Approving costs one extra `gh pr view` call** to re-check the head commit.
