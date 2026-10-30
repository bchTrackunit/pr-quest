# PR Quest API spike (GLU-2852)

Checked on 2026-10-30 against live APIs.

## Linear public GraphQL (`https://api.linear.app/graphql`)

Introspection works without an API key, so these findings come from the live schema.

- **No way to list review requests.** The only diff entry point is `diff(id)`, marked
  `[Internal]`. There is no `diffs` or `pullRequests` connection and no reviewer or review-state
  filter.
- **No review data on the types.** `PullRequest` has `slugId`, `title`, `number`, `sourceBranch`,
  `targetBranch`, `headSha`, `baseSha`, `url`, `status` (`PullRequestStatus`: draft, open,
  inReview, approved, merged, closed), `mergeStatus`, `openedAt`, `creator`. It has no `reviewers`,
  `viewerReviewState`, `needsAttention` or `fullIdentifier`. `Diff` has `fileCount`, `additions`,
  `deletions`, `slugId`, `pullRequest`, `creator` (most fields `[Internal]`).
- **No approve mutation.** No mutation name contains `review`, `approve`, `diff` or
  `pullRequest`.
- **Linking to Linear:** `attachmentsForURL(url)` can find issues that link a GitHub PR, but the
  review page slug (`/review/<slug>`) is only reachable through the internal `diff(id)`.

## Linear MCP (`https://mcp.linear.app/mcp`)

The MCP server has the review tools the plan relies on: `list_diffs` (filters `reviewer: "me"`,
`reviewState: pending | approved | changesRequested | commented | dismissed`, `owner`, `repo`,
`status`, `query`, cursor paging) and `submit_diff_review`
(`{ urlOrId, decision: approved | changesRequested | commented, body? }`). `urlOrId` accepts a
GitHub PR URL. The endpoint takes `Authorization: Bearer <token>` (it returned
`401 invalid_token` for a bad token). Not verified: whether a personal `LINEAR_API_KEY` is
accepted there, because no key was available during the spike.

## GitHub CLI (`gh` 2.103.2, logged in as `bchTrackunit`)

- `gh search prs --review-requested=@me --state=open --json number,title,url,repository,author,createdAt,updatedAt,isDraft,labels`
  works. It includes team requests. `gh search prs user-review-requested:@me --state=open` (raw
  qualifier) returns direct requests only, so the difference gives `requestKind`.
- Search results carry no branches or diff stats. Per PR, use
  `gh pr view <n> -R <owner>/<repo> --json headRefName,baseRefName,headRefOid,additions,deletions,changedFiles,reviewRequests`.
  `reviewRequests` lists users and teams (`{"__typename":"Team","slug":"Trackunit/team-gluon"}`).
- `gh pr review <n> -R <owner>/<repo>` supports `--approve`, `--comment`, `--request-changes`,
  `--body` and `--body-file`. It cannot add inline comments; use
  `gh api -X POST repos/<owner>/<repo>/pulls/<n>/reviews` with `event` and a `comments[]` array of
  `{ path, line, side, body }`.

## Cursor SDK (`@cursor/sdk`)

- npm `latest` is 1.2.0 (2026-10-27). The repo's 7-day `npmMinimalAgeGate` resolves to **1.0.40**,
  which is what is installed. `zod` (`^3.25 || ^4`) is a required peer and was added too.
- Cloud options (`CloudAgentOptions` in `dist/esm/options.d.ts`):

  ```ts
  cloud: {
    repos: [{ url: string; startingRef?: string; prUrl?: string }],
    autoCreatePR?: boolean,
    skipReviewerRequest?: boolean,
    workOnCurrentBranch?: boolean,
    envVars?: Record<string, string>,
    metadata?: Record<string, string>,
    env?: { type: 'cloud' | 'pool' | 'machine'; name?: string },
  }
  ```

- `model` is optional for cloud (server default); `name` sets the agent title.
- `tools`, `disallowedTools` and `systemPrompt` throw a `ConfigurationError` with `cloud`, so the
  "no commits, no PR" rule can only be enforced through the prompt plus `autoCreatePR: false`.
- There is no structured-output option: the agent's final text (`RunResult.result`) must be
  parsed as JSON and validated (zod is available).
- Run statuses: `running | finished | error | cancelled`. A thrown `CursorAgentError` (with
  `isRetryable`) means the run never started.

## Decision

- **List quests:** `gh` (search plus `gh pr view` per PR) as the baseline; try Linear MCP
  `list_diffs` first when a key works there, since it adds `appUrl`, `needsAttention` and
  team-request data in one call.
- **Approve:** Linear MCP `submit_diff_review` when available, otherwise `gh pr review --approve`.
- **Post findings:** `gh api .../pulls/<n>/reviews` with inline comments.
- **Review agent:** `Agent.create({ cloud: { repos: [{ url, startingRef: sourceBranch }], autoCreatePR: false, skipReviewerRequest: true } })`.
  Requires the user's Cursor GitHub integration to have access to the repo.
