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

The quest list refreshes every 2 minutes and when you press **Refresh**. Other checks:

```sh
yarn nx run-many -t tsc-validate lint test build -p pr-quest
```

Nx loads `apps/pr-quest/.env.local` into the `serve` task's environment. To run without a key,
remove it from the file; blanking the variable in your shell doesn't override it under Nx.

## How it works

- **Quests** come from `gh search prs --review-requested=@me`, which includes team requests. A
  second search with `user-review-requested:@me` tells direct requests apart. Branches, diff
  stats and requested teams for every PR come from batched `gh api graphql` queries (25 PRs per
  query). If a batch fails, PR Quest falls back to one `gh pr view` per PR.
- **Linear** is optional. With `LINEAR_API_KEY`, the server calls Linear's MCP `list_diffs` tool
  to add each PR's Linear review link and `needsAttention` flag. Any Linear failure falls back to
  GitHub data only.
- **Tiers** use additions plus deletions: Trivial under 50 lines, Normal under 400, Hard under
  2,000 lines and 50 files, and Boss above that.
- **Sorting**: direct requests first, then PRs that need attention, then the longest-waiting.

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
  2–3 seconds of batched GraphQL. Pressing Refresh many times in a row can hit GitHub's search
  rate limit (30 searches a minute, and each refresh uses 2). The board then shows the last
  known quests with an error until the limit resets.
- **The no-commit rule is prompt-only**, as described above.
