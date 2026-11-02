# How PR Quest works

This is the detail behind the [README](../README.md): which GitHub calls PR Quest makes, how the
reviewers are kept in check, how the local server protects itself and how state is stored.

## Quests

PR Quest calls GitHub's REST and GraphQL APIs directly with `fetch` and your token. The only
command it runs is `gh auth token`, for the GitHub CLI fallback.

- **Quests** come from a `GET /search/issues` search for `review-requested:@me`, which includes
  team requests. A second search with `user-review-requested:@me` tells direct requests apart.
  Branches, diff stats, draft state, latest reviews and requested teams come from batched GraphQL
  queries, 25 PRs per query. If a batch fails, PR Quest falls back to one query per PR, except on
  a rate limit. A PR whose details still can't be read is left off the board. If that happens to
  more than half of the PRs, the refresh counts as failed and the server keeps serving the
  previous list, so a network problem can't empty the board.
- **Approved by others** means someone other than you has an `APPROVED` latest review. At most
  100 latest reviews are read per PR.
- **Linear** is optional. With a Linear key, the server calls Linear's MCP `list_diffs` tool to
  add each PR's Linear review link and `needsAttention` flag. Any Linear failure falls back to
  GitHub data only.
- **Refreshing** takes about 5 seconds for around 50 PRs. The server checks GitHub every 2
  minutes and on **Refresh**; loading the page or reconnecting the live updates stream uses the
  cached list.

## GitHub rate limits

GitHub's search API allows 30 searches a minute, and each refresh uses 2.

- **Cache on disk.** The last successful list is saved to `quests.json`. On startup the server
  serves it straight away and only asks GitHub again when it is more than 60 seconds old. The
  poll also skips GitHub while the list is fresh.
- **Detection.** A failed response with `x-ratelimit-remaining: 0`, or an error mentioning "API
  rate limit exceeded", is a primary limit. A `retry-after` header, "secondary rate limit", abuse
  detection and HTTP 429 are secondary limits. A plain 403 isn't, because GitHub also uses it for
  missing permissions and SAML.
- **Backoff.** PR Quest waits until the reset time from the failed response's
  `x-ratelimit-reset` or `retry-after` header, or, for a primary limit, from `GET /rate_limit`,
  which doesn't count against the limit. Without any reset time, it waits 60 seconds, doubling on
  each repeat up to 10 minutes, so a secondary limit without `retry-after` always uses this
  backoff. The backoff is saved with the cache, so a restart doesn't retry early.
- **During the backoff** the poll, **Refresh** and `?refresh=1` don't call GitHub. The API
  returns the cached quests with `stale: true` and `rateLimit: { kind, limitedUntil }`, the board
  shows a banner with the retry time, and the server retries once by itself when the backoff ends.

If GitHub limits PR Quest before it has ever fetched a list, the API returns `503 rateLimited`
and the board shows that as an error.

## The Cursor review agent

With the Cursor provider, **Send review agent** starts a Cursor cloud agent through
`@cursor/sdk`, pinned to the quest's head commit, so pushes made after you send it don't change
what it reviews. The repo is always the base repo; the prompt has the agent check out
`pull/<number>/head` if it didn't start on that commit. The agent:

- reviews only `git diff origin/<target>...HEAD` at that commit, reading other code for context;
- is told never to commit, push, create branches, open or update a PR, approve or comment;
- is told not to repeat what the PR's [existing comments](#existing-comments) already raise;
- returns a JSON report (`summary`, an advisory `verdict`, `findings` with file, line, severity,
  body and an optional suggested replacement, and `reviewedSha`), which the server validates. If `reviewedSha` isn't the commit the
  agent was sent to, the run fails rather than offer findings whose line numbers may be wrong.

### Which PRs it reviews

The server refuses a Cursor review before anything is queued, and suggests Claude, when:

- the PR's author isn't `OWNER`, `MEMBER` or `COLLABORATOR` of the repo. The exception is the
  trusted bots `dependabot[bot]` and `renovate[bot]`, which GitHub gives no role. GitHub reserves
  the `[bot]` suffix for GitHub Apps, so no person can open a PR under those logins;
- the PR comes from a fork. A branch in the base repo can only have been pushed by someone with
  write access, who gains nothing by steering the agent;
- either branch name contains anything but letters, digits and `. _ / + @ = -`, or starts with
  `-` or `+`. Git allows shell characters in branch names, and the prompt asks the agent to run
  commands that contain them.

The board applies the same rules: with Cursor selected, such a quest's **Send review agent**
button is disabled with the reason and a shortcut to the provider setting. If the author's role or
the fork state is unknown, for example on a board cached by an older version, refreshing fixes it.

### What it can do

The cloud agent runs with your Cursor identity, through your Cursor GitHub integration, on PR
content the PR's author controls. Cloud agents don't accept a system prompt or tool restrictions,
so every rule above exists only in the prompt, and a prompt injection in the PR could talk the
agent out of them. The only hard guard is `autoCreatePR: false`, which stops the SDK from opening
a PR for the agent's work. PR Quest also sets `workOnCurrentBranch: false`, but the SDK doesn't
document what that prevents.

Dependabot and Renovate PRs carry content written by a dependency's maintainers: release notes,
changelogs and the version the lockfile points at. A malicious or compromised release can carry a
prompt injection, and if the repo's Cursor environment installs dependencies, that install runs
the new version's install scripts inside the agent. Review such PRs with Claude when you don't
trust the upstream release.

Starting the agent on a commit SHA is untested against the live Cursor API: the SDK types allow
any `startingRef` but don't say whether a SHA is accepted. If the agent starts elsewhere, the
prompt has it check out the commit, and a mismatched `reviewedSha` fails the run.

## Claude reviews

With the Claude provider, the server reviews the PR's diff, never the repo:

- **The diff is pinned to the quest's head commit.** It comes from GitHub's compare API
  (`<target>...<headSha>`). If that fails, PR Quest uses the PR's own diff, but only while the
  PR's head is still that commit.
- **Some files are left out.** Lockfiles, generated files (`dist/`, `build/` and `out/` at the
  repo root, `vendor/` and `node_modules/` anywhere, snapshots, minified files, source maps and
  similar) and binary files are dropped. The rest are kept in order while they fit in about
  280,000 characters; a file that doesn't fit is left out as too large, and smaller files after it
  still get in. If nothing is left, the review fails without calling Anthropic.
- **Claude is told what it can't see.** The prompt lists up to 200 omitted files, as escaped
  strings so a file name can't add lines to the prompt. The result screen shows all of them under
  **Omitted files**, and a posted review lists up to 50.
- **PR content is treated as data.** The title, branches and diff sit between delimiters with a
  random nonce, and the system prompt says never to follow instructions inside them and to report
  attempts to steer the reviewer as a security finding.
- **The answer is a forced tool call.** The request offers one tool, `submit_review`, and makes
  Claude call it. The server validates its input as the same report the Cursor agent returns, with
  up to 16,000 output tokens. A refusal, a truncated answer or invalid output fails the run.

Claude can't run code, read the repo or write anywhere, and nothing it returns reaches GitHub
until you post it. A prompt injection in the diff can still make the review wrong or misleading,
so treat findings as advice. The diff, title, branch names and the PR's trusted comments are sent
to Anthropic under your API key.

## Existing comments

Before either reviewer starts, the server reads what has already been said on the PR, in one
GraphQL query: the newest 100 review summaries, inline threads (up to 50 comments each, with their
file, line and whether they're resolved or outdated) and conversation comments. Pending reviews,
draft comments and empty bodies are skipped. Each comment is cut to 2,000 characters and the list
to about 40,000. The prompt lists them as JSON lines between nonce markers, says they're data
rather than instructions, and asks the reviewer not to report what a comment already raises
unless it found something that changes the fix or the severity.

A reviewer skips what comments already raise, so a comment could talk it out of a finding. A
comment is therefore only passed on when its author gains nothing by steering the reviewer:

- **The PR's author**, who already controls the diff and gains nothing more from a comment. On a
  PR from a fork, which only Claude reviews, that is someone who can't push to the repo.
- **People who can push to the repo.** Every other `OWNER`, `MEMBER` or `COLLABORATOR` is checked
  with `GET /repos/{owner}/{repo}/collaborators/{login}/permission`, and only `admin` and `write`
  pass. A check that fails for any reason counts as no access.
- **Review bots:** Bugbot (`cursor`), Copilot (`copilot-pull-request-reviewer`) and CodeRabbit
  (`coderabbitai`), matched only on GitHub App accounts. Other apps, `github-actions` among them,
  can post text anyone wrote, so they're left out. A review bot's reply after a left-out comment
  in the same thread is dropped too, since it may quote it.

Everything else is left out and only counted in the server log. If GitHub can't list the
comments, the review runs without them. Comments are read at the PR's latest head, so if it moved
since the board last refreshed, a thread's line may belong to a newer commit.

## Posting and approving

PR Quest never turns reviewer output into an approval. The verdict is shown as advice, the post
endpoint accepts only `comment` and `requestChanges`, and the only way to approve is the
**Approve** dialog.

**Selecting findings.** The selection is saved on the server with the run as you make it
(`PUT /api/runs/:id/selection`), so it survives a reload and a restart, and other open tabs see it
through the live updates stream. Once a run is posted, its selection can't change. Selecting
earns no XP and costs none.

**Posting.** The confirmation says what will go out, for example "Posting 3 of 6 findings in one
GitHub review: 2 as inline comments and 1 as a comment on its file." With nothing selected, it
says the review will hold only the summary, and you can still post it. It always starts at
**Comment**; when the reviewer suggests requesting changes, it says so but never picks it for you.
The server doesn't trust the page: the post request names the findings you confirmed, and the
server refuses with `409` if they differ from its saved selection, for example because another tab
changed it. The footer names the provider and model, and `@user` or `@org/team` in the reviewer's
text is wrapped in backticks so nobody is pinged. Posting earns the same XP however many findings
it includes.

**Where findings go.** Findings are always comments, never part of the review body, which holds
only the summary, the advisory verdict and the omitted files. The review is anchored to the commit
that was reviewed:

- A finding with a line is an inline comment on it. When the reviewer wrote replacement code
  (`suggestion`, optionally over `startLine` to `line`), the comment carries a GitHub suggested
  change.
- A finding without a line is a comment on its file. GitHub's REST API can't add those to a review,
  so PR Quest creates the review pending, adds them with GraphQL's `addPullRequestReviewThread`,
  then submits it.
- GitHub refuses a whole review if one line is outside the diff. PR Quest then starts the review
  pending and empty and adds each finding on its own; only a finding whose line is refused moves
  to its file, with the line named in the comment and any suggestion shown as plain code.
- If GitHub won't take a finding even on its file, usually because the file isn't part of the PR,
  PR Quest deletes the pending review, posts nothing and answers `409` naming the file, so you can
  deselect it and post again.

When every finding has a line GitHub accepts, the review goes out in one request. GitHub allows one
pending review per person and PR, so if you have one open in GitHub's own UI, PR Quest posts
nothing and asks you to submit or discard it first.

**Approving.** The dialog names the PR and the short head commit you're approving. The server
reads the PR's current head first; if new commits were pushed, it approves nothing and answers
`409 headChanged`, and the dialog shows the new commit. Otherwise it approves with
`POST /repos/<owner>/<repo>/pulls/<number>/reviews`, `event: APPROVE` and `commit_id` set to that
commit. The board disables **Approve** on draft PRs.

Runs are saved, so a server restart reattaches to a Cursor run that was still going. A Claude
review is a single request, so a restart during one marks it as failed.

## Local server protections

The API acts as you, so it only accepts browser requests that come from PR Quest's own UI:

- **Host** must be `127.0.0.1` or `localhost`, which stops DNS rebinding.
- **Origin**, when the browser sends one, must be exactly the UI or API origin. Pages on other
  localhost ports, such as another dev server, get `403`.
- **`Sec-Fetch-Site`**, when the browser sends it, must be `same-origin` or `none` on every
  request, including GETs, so an image or script tag on another page can't trigger a call.
- **Every POST, PUT and DELETE must be `Content-Type: application/json`**, or the server answers
  `415`. A browser can't send JSON to another origin without a CORS preflight, which the server
  never grants.

These checks stop other websites, not other programs. A request without `Origin` or
`Sec-Fetch-Site`, such as one from `curl`, passes them, and the API has no authentication, so any
process running on this computer, under any user, can call it and act as you.

Secrets stay in the server process. The UI only learns whether a key is set, its source and, for
keys of 12 characters or more, its last four characters. The server doesn't log keys or the
token, and `gh auth token` runs without the API keys in its environment. `secrets.json` is
protected by its `0600` mode and the `0700` directory, not encrypted or kept in the macOS
keychain, so backups of your home folder include it.

## Where state lives

`secrets.json` and `settings.json` in `~/.pr-quest` are shared; `users/<login>/` belongs to
whoever the current token is, named by the lower-cased login. Signing in as someone else opens
their own folder, starting fresh. Keys set in the environment or `.env.local` are never written to
`secrets.json`. Files are written atomically.

When a file can't be used:

- An unreadable `state.json` or `secrets.json` is moved aside as `<file>.corrupt-<time>`, and PR
  Quest starts without it. An unreadable finding selection on a run only drops that selection.
- An unreadable `settings.json` is replaced with the defaults; an unreadable `quests.json` is
  ignored until the next successful fetch.
- A `secrets.json` or `settings.json` written by a newer PR Quest stops the server at startup, so
  an older build never overwrites it. A newer `state.json` is left in place, and the game reports
  an error instead of loading it.
- The first time PR Quest reads a version 1 `state.json`, it copies it to `state.json.v1.bak`.
  Copy it back to run an older build.
- Runs saved before findings were selected for posting kept an accepted or rejected decision per
  finding. They load with the accepted findings selected, which were the ones that got posted.

Before per-user folders, `state.json` and `quests.json` sat directly in `~/.pr-quest`. The first
GitHub user PR Quest sees gets them: they are copied into `users/<login>/` and the originals are
renamed to `<file>.migrated-to-<login>-<UTC time>.bak`, which nothing reads again. A user who
already has a `state.json` in their folder keeps it. The login is recorded in
`users/.legacy-owner` first, so an interrupted migration finishes for the same user.
A `state.json` or `quests.json` that shows up in `~/.pr-quest` later is renamed to
`<file>.orphaned-<UTC time>.bak` rather than given to anyone.

## Achievements

"Review action" means posting a review, requesting changes or approving. Times and days use the
server's local clock, and the daily counts (Clean Sweep, Featherweight) start again at local
midnight. The Achievements dialog shows progress where there is a count and hides secret
achievements behind a hint until they unlock.

| Achievement      | How to unlock                                                                       | Rarity    |
| ---------------- | ----------------------------------------------------------------------------------- | --------- |
| **Milestones**   |                                                                                     |           |
| First Blood      | Your first review action                                                            | Common    |
| Centurion Bronze | 10 review actions                                                                   | Common    |
| Centurion Silver | 50 review actions                                                                   | Rare      |
| Centurion Gold   | 100 review actions                                                                  | Legendary |
| Team Player      | 10 review actions on team-requested PRs                                             | Rare      |
| Agent Commander  | 10 finished agent reviews                                                           | Rare      |
| Gatekeeper       | Request changes on 5 different PRs                                                  | Rare      |
| Giant Killer     | Approve 5 Boss-tier PRs                                                             | Epic      |
| **Streaks**      |                                                                                     |           |
| On Fire          | A 5-day streak                                                                      | Epic      |
| Unstoppable      | A 7-day streak                                                                      | Legendary |
| Early Bird       | A review action before 08:00                                                        | Common    |
| Night Owl        | A review action at 22:00 or later                                                   | Common    |
| Weekend Warrior  | A review action on a Saturday or Sunday                                             | Common    |
| **Feats**        |                                                                                     |           |
| Quick Draw       | Approve within an hour of the PR opening                                            | Rare      |
| Boss Slayer      | Post a review on, or approve, a Boss-tier PR                                        | Rare      |
| Inbox Zero       | GitHub finds no review requests on a day you reviewed something                     | Rare      |
| Clean Sweep      | Act on 5 direct requests in a day, and leave no direct request on the board         | Epic      |
| Necromancer      | A review action on a PR that has waited 30 days or more                             | Rare      |
| The Long Read    | A review action on a PR with 2,000 or more changed lines                            | Rare      |
| Eagle Eye        | Post a review that includes a critical or major finding                             | Common    |
| Featherweight    | Approve 10 Trivial PRs in a day, each after a posted review or finished agent       | Rare      |
| Second Opinion   | A finished Claude review and a finished Cursor review on the same PR                | Rare      |
| **Variety**      |                                                                                     |           |
| Explorer         | Review actions in 10 different repos                                                | Rare      |
| Diplomat         | Review actions on PRs from 10 different people, not counting yourself or bots       | Rare      |
| Bot Wrangler     | Review actions on 10 PRs by Dependabot or Renovate                                  | Rare      |
| **Secret**       |                                                                                     |           |
| Speedrunner      | Approve within 5 minutes of the PR opening, after a posted review or finished agent | Epic      |
| Archaeologist    | A review action on the quest that has waited longest on your board                  | Rare      |

Inbox Zero counts only what GitHub's search returns: hiding a quest you just approved doesn't
count, and neither does a refresh where most PR details couldn't be read.

Achievements are defined in
[`apps/server/src/features/game/achievements.ts`](../apps/server/src/features/game/achievements.ts);
the UI renders whatever that file lists.

Achievements unlocked before bonus XP existed don't pay it afterwards.

State from before these achievements keeps its XP, level, streak and unlocked achievements, and
some progress is rebuilt from what was stored: Centurion, Team Player and Agent Commander from the
counters, Explorer from rewarded approvals and posted reviews, Giant Killer and Eagle Eye from
stored runs, and Second Opinion from the run history. Anything rebuilt unlocks, with its bonus, at
the next game event. The other achievements need details older state never stored, so they count
only actions from then on.
