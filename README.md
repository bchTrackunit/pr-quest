# PR Quest

PR Quest is a small local web app that turns the pull requests you've been asked to review into
quests. Each open review request becomes a card with a difficulty tier based on its diff size.
From a card you can send a Cursor cloud agent to review the PR, read its findings, post them to
GitHub, or approve the PR. Real review actions earn XP, levels, a daily streak and achievements.

It runs entirely on your machine. The server binds to `127.0.0.1` only, because it acts as you
through your `gh` login.

![The PR Quest board: player HUD, quest filters and direct-request quest cards with tiers](docs/screenshot.png)

## Prerequisites

- **GitHub CLI**, logged in: `gh auth login`. PR Quest lists, approves and posts reviews as the
  `gh` user. Check it with `gh auth status`.
- **Node and Yarn through [Volta](https://volta.sh)**. The versions are pinned in the root
  `package.json`; run `yarn install` from the engineering repo root.
- **Optional keys** in `apps/pr-quest/.env.local` (git-ignored):

  ```sh
  # Enables "Send review agent". Create one at https://cursor.com/dashboard/integrations
  CURSOR_API_KEY=...
  # Optional Linear enrichment: review page links and the "needs attention" flag
  LINEAR_API_KEY=...
  ```

  Without `CURSOR_API_KEY` the board, approvals and XP still work, and "Send review agent" shows
  a message that the key is missing. Environment variables take precedence over the file.

Other optional settings: `PR_QUEST_PORT` (API, default `4317`), `PR_QUEST_UI_PORT` (UI, default
`4318`) and `PR_QUEST_STATE_DIR` (default `~/.pr-quest`).

## Run it

From the engineering repo root:

```sh
yarn nx serve pr-quest
```

This starts the API on <http://127.0.0.1:4317> and the UI on <http://127.0.0.1:4318>. Open the UI
in a browser or in Cursor's browser tab. The UI proxies `/api` to the server and receives live
updates over server-sent events; the indicator in the HUD shows "Live" when it is connected.

The server checks GitHub every 2 minutes and when you press **Refresh**. Loading the page or
reconnecting the live stream never forces a GitHub call; both use the server's cached list.
Other checks:

```sh
yarn nx run-many -t tsc-validate lint test build -p pr-quest
```

Nx loads `apps/pr-quest/.env.local` into the `serve` task's environment. To run without a key,
remove it from the file; blanking the variable in your shell doesn't override it under Nx.

## How it works

- **Quests** come from `gh search prs --review-requested=@me`, which includes team requests. A
  second search with `user-review-requested:@me` tells direct requests apart. Branches, diff
  stats, draft state, latest reviews and requested teams for every PR come from batched
  `gh api graphql` queries (25 PRs per query). If a batch fails, PR Quest falls back to one
  `gh pr view` per PR, except when the failure is a rate limit.
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

"Send review agent" starts a Cursor cloud agent on the PR's source branch through
`@cursor/sdk`. The agent:

- reviews only `git diff origin/<target>...HEAD`, reading other code just for context;
- is told never to commit, push, create branches, open or update a PR, approve or comment;
- returns a JSON report (`summary`, advisory `verdict`, and `findings` with file, line,
  severity and body), which the server validates.

Cloud agents don't accept a system prompt or tool restrictions, so the no-commit rule exists
only in the prompt. The one hard guard is `autoCreatePR: false`. The agent works through your
Cursor GitHub integration, which needs access to the repo.

The agent never approves. Its verdict is advice only. Findings appear on a result screen first,
and nothing reaches GitHub until you choose **Post to PR** and confirm. That posts one GitHub
review (comment or request changes) with inline comments. If GitHub rejects the inline line
numbers, it posts them in the review body instead. **Approve** is a separate action with its own
confirmation dialog, and it uses `gh pr review --approve`.

Runs are saved, so a server restart reattaches to a run that was still going.

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

| Achievement     | How to unlock                                    | Bonus XP |
| --------------- | ------------------------------------------------ | -------- |
| First Blood     | Your first post, request for changes or approval | 10       |
| Quick Draw      | Approve within an hour of the review request     | 25       |
| Boss Slayer     | Review or approve a Boss-tier PR                 | 50       |
| Team Player     | 10 review actions on team-requested PRs          | 40       |
| Inbox Zero      | Empty queue on a day you reviewed something      | 30       |
| On Fire         | A 5-day streak                                   | 75       |
| Agent Commander | 10 finished agent reviews                        | 40       |

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
- **The no-commit rule is prompt-only**, as described above.
