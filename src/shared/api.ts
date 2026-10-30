/**
 * The contract between the PR Quest server and UI: domain types, the REST route map and the
 * server-sent event union. Both sides import from here; nothing in this file may depend on
 * Node or browser APIs.
 *
 * All timestamps are ISO 8601 strings in UTC unless a field says otherwise.
 */

// ---------------------------------------------------------------------------
// Quests (pull requests awaiting the player's review)
// ---------------------------------------------------------------------------

export type DifficultyTier = 'Trivial' | 'Normal' | 'Hard' | 'Boss';

/** `direct`: the player was requested by name. `team`: requested through a GitHub team. */
export type RequestKind = 'direct' | 'team';

/** Mirrors Linear's `PullRequestStatus` enum. */
export type PullRequestStatus = 'draft' | 'open' | 'inReview' | 'approved' | 'merged' | 'closed';

/** Where the quest data was read from. Linear is preferred; `gh` is the fallback. */
export type QuestSource = 'linear' | 'github';

export interface RepoRef {
  owner: string;
  name: string;
}

export interface DiffStats {
  fileCount: number;
  additions: number;
  deletions: number;
}

export interface QuestAuthor {
  name: string;
  githubLogin?: string;
}

export interface Quest {
  /**
   * Stable id in Linear's full-identifier form, `<owner>/<repo>#<number>`
   * (for example `Trackunit/manager#26944`). Use `buildApiPath`, which URL-encodes it.
   */
  id: string;
  title: string;
  repo: RepoRef;
  number: number;
  author: QuestAuthor;
  sourceBranch: string;
  targetBranch: string;
  /** Head commit of the source branch, when known. */
  headSha?: string;
  status: PullRequestStatus;
  isDraft: boolean;
  /** Someone other than the player has a latest review of `APPROVED` on the PR. */
  approvedByOthers: boolean;
  /** How many people other than the player have a latest review of `APPROVED`. */
  approvalCount: number;
  diffStats: DiffStats;
  difficulty: DifficultyTier;
  requestKind: RequestKind;
  /** GitHub team slugs the request came through; empty for direct requests. */
  requestedTeams: Array<string>;
  needsAttention: boolean;
  githubUrl: string;
  /** Linear review page (`https://linear.app/<workspace>/review/<slug>`), when it resolved. */
  linearUrl?: string;
  openedAt: string;
  updatedAt: string;
  /** Best-known time the player's review was requested; falls back to `openedAt`. */
  requestedAt: string;
  source: QuestSource;
  /** The newest review run for this quest that is still queued, running or awaiting a decision. */
  activeRunId?: string;
}

// ---------------------------------------------------------------------------
// Review runs (Cursor cloud agents reviewing a quest)
// ---------------------------------------------------------------------------

/**
 * `startupFailed`: the SDK threw before the run executed (auth, config, network).
 * `error`: the run executed and failed.
 */
export type ReviewRunStatus = 'queued' | 'running' | 'finished' | 'error' | 'startupFailed';

/** What the player did with a finished run's findings. */
export type ReviewRunDisposition = 'pending' | 'posted' | 'discarded';

export type FindingSeverity = 'critical' | 'major' | 'minor' | 'nit';

export type ReviewVerdict = 'approve' | 'comment' | 'requestChanges';

export interface ReviewFinding {
  /** Repository-relative path. */
  file: string;
  /** Line in the new version of the file; omitted for file-level findings. */
  line?: number;
  severity: FindingSeverity;
  /** Markdown. */
  body: string;
}

/** The JSON the review agent must return. The verdict is advisory; the agent never approves. */
export interface ReviewResult {
  summary: string;
  verdict: ReviewVerdict;
  findings: Array<ReviewFinding>;
}

export interface ReviewRunError {
  message: string;
  /** From `CursorAgentError.isRetryable`; only set for `startupFailed`. */
  retryable?: boolean;
}

/**
 * The quest as it was when the run started. It stays on the run because the quest can leave the
 * queue (approved elsewhere, merged) while its findings are still waiting for a decision.
 */
export interface ReviewRunQuest {
  title: string;
  repo: RepoRef;
  number: number;
  githubUrl: string;
  linearUrl?: string;
}

export interface ReviewRun {
  id: string;
  questId: string;
  quest: ReviewRunQuest;
  /** Cursor cloud agent id (`bc-...`); absent until the agent is created. */
  agentId?: string;
  /** Cursor run id; absent until the first send returns. */
  runId?: string;
  status: ReviewRunStatus;
  disposition: ReviewRunDisposition;
  startedAt: string;
  finishedAt?: string;
  /** Set when `status` is `finished` and the agent output parsed as a `ReviewResult`. */
  result?: ReviewResult;
  error?: ReviewRunError;
  /** GitHub URL of the review created by `POST /api/runs/:id/post`. */
  postedReviewUrl?: string;
}

// ---------------------------------------------------------------------------
// Gamification
// ---------------------------------------------------------------------------

export type AchievementId =
  | 'first-blood'
  | 'quick-draw'
  | 'boss-slayer'
  | 'team-player'
  | 'inbox-zero'
  | 'on-fire'
  | 'agent-commander';

export interface AchievementDef {
  id: AchievementId;
  name: string;
  description: string;
  /** A single emoji or short glyph shown on the badge. */
  icon: string;
  xpReward: number;
  /** Hidden achievements show as "???" until unlocked. */
  secret?: boolean;
  /** Counter target for progress bars, e.g. 10 for Team Player. */
  target?: number;
}

export interface UnlockedAchievement {
  id: AchievementId;
  unlockedAt: string;
}

export interface PlayerCounters {
  reviewsPosted: number;
  approvals: number;
  changesRequested: number;
  agentReviews: number;
  teamReviews: number;
  bossesSlain: number;
  quickDraws: number;
}

export interface PlayerState {
  /** Lifetime XP. */
  xp: number;
  level: number;
  /** XP earned since reaching `level`. */
  xpIntoLevel: number;
  /** XP needed to go from `level` to `level + 1`. */
  xpForNextLevel: number;
  streakDays: number;
  /** Local calendar date (`YYYY-MM-DD`) of the most recent review action. */
  lastReviewDate?: string;
  achievements: Array<UnlockedAchievement>;
  counters: PlayerCounters;
}

/** XP is only awarded for real actions, never for merely starting an agent. */
export type XpReason = 'reviewPosted' | 'approved' | 'changesRequested' | 'achievement';

export interface AchievementStatus extends AchievementDef {
  unlockedAt?: string;
  /** Current counter value toward `target`. */
  progress?: number;
}

/**
 * One XP award. The server also broadcasts it as an `xpGained` event with the same `eventId`, so a
 * client that sees it both ways counts it once.
 */
export interface XpGain {
  eventId: string;
  amount: number;
  reason: XpReason;
  questId?: string;
}

/** Game side effects of an action, returned so the UI can animate without waiting for SSE. */
export interface GameOutcome {
  /** Sum of `gains`. */
  xpGained: number;
  /** The action's award first, then one per unlocked achievement. */
  gains: Array<XpGain>;
  player: PlayerState;
  unlocked: Array<UnlockedAchievement>;
}

// ---------------------------------------------------------------------------
// Server-sent events (GET /api/events)
// ---------------------------------------------------------------------------

/**
 * Each SSE message is a single `data:` line holding one JSON-encoded `ServerEvent`; the SSE
 * `event:` field is not used, so clients read everything through `EventSource.onmessage`.
 */
export type ServerEvent =
  | ({ type: 'questsUpdated' } & ListQuestsResponse)
  | { type: 'runUpdated'; run: ReviewRun }
  | { type: 'achievementUnlocked'; achievement: AchievementDef; unlockedAt: string }
  | ({ type: 'xpGained'; player: PlayerState } & XpGain);

export type ServerEventType = ServerEvent['type'];

// ---------------------------------------------------------------------------
// REST request and response bodies
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: true;
  /** Which credentials are configured. Never carries the secret values. */
  config: {
    linearApiKey: boolean;
    cursorApiKey: boolean;
  };
}

/**
 * `primary`: the hourly or per-minute quota ran out (search allows 30 a minute).
 * `secondary`: GitHub throttled bursts of requests.
 */
export type RateLimitKind = 'primary' | 'secondary';

export interface RateLimitStatus {
  kind: RateLimitKind;
  /** The server makes no GitHub calls for the quest list before this time. */
  limitedUntil: string;
}

export interface ListQuestsResponse {
  quests: Array<Quest>;
  /** When these quests were read from GitHub. */
  fetchedAt: string;
  source: QuestSource;
  /** The quests are older than the cache lifetime, for example because GitHub is rate limited. */
  stale: boolean;
  /** Set while GitHub rate limits the quest list. */
  rateLimit?: RateLimitStatus;
}

export interface StartReviewRequest {
  /** Cursor model id; the server picks its default when omitted. */
  model?: string;
}

export interface RunResponse {
  run: ReviewRun;
}

export interface ListRunsResponse {
  runs: Array<ReviewRun>;
}

export type PostReviewEvent = 'comment' | 'requestChanges';

export interface PostReviewRequest {
  /** GitHub review event. Defaults to `comment`. Approving is a separate, explicit action. */
  event?: PostReviewEvent;
  /** Indexes into `result.findings` to post; all findings when omitted. */
  findingIndexes?: Array<number>;
}

export interface PostReviewResponse {
  run: ReviewRun;
  reviewUrl: string;
  outcome: GameOutcome;
}

export interface ApproveRequest {
  /** Must be `true`; the UI sets it only after the player confirms. */
  confirm: true;
  /**
   * The quest's `headSha` the player saw. The approval is pinned to this commit; if the PR has
   * moved on, the server refuses with `headChanged` and approves nothing.
   */
  headSha: string;
  /** Optional approval comment (Markdown). */
  body?: string;
}

export interface ApproveResponse {
  questId: string;
  approvedVia: QuestSource;
  outcome: GameOutcome;
}

export interface PlayerResponse {
  player: PlayerState;
}

export interface ListAchievementsResponse {
  achievements: Array<AchievementStatus>;
}

export type ApiErrorCode =
  | 'badRequest'
  | 'forbidden'
  | 'notFound'
  | 'conflict'
  /** The PR's head commit is no longer the `headSha` the approval named; the quest was updated. */
  | 'headChanged'
  | 'missingConfig'
  | 'upstreamFailed'
  /** GitHub is rate limited and there are no cached quests to serve yet. */
  | 'rateLimited'
  | 'notImplemented'
  | 'internal';

/** Body of every non-2xx JSON response. */
export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Route map
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST';

export const API_ROUTES = {
  health: { method: 'GET', path: '/api/health' },
  /**
   * Serves a cache younger than 60 seconds; `?refresh=1` fetches unless GitHub is rate limited,
   * in which case the cached quests come back with `rateLimit` set.
   */
  listQuests: { method: 'GET', path: '/api/quests' },
  startReview: { method: 'POST', path: '/api/quests/:id/review' },
  approveQuest: { method: 'POST', path: '/api/quests/:id/approve' },
  listRuns: { method: 'GET', path: '/api/runs' },
  getRun: { method: 'GET', path: '/api/runs/:id' },
  postRun: { method: 'POST', path: '/api/runs/:id/post' },
  discardRun: { method: 'POST', path: '/api/runs/:id/discard' },
  getPlayer: { method: 'GET', path: '/api/player' },
  listAchievements: { method: 'GET', path: '/api/achievements' },
  /** Server-sent event stream of `ServerEvent`. */
  events: { method: 'GET', path: '/api/events' },
} as const satisfies Record<string, { method: HttpMethod; path: `/api/${string}` }>;

export type RouteName = keyof typeof API_ROUTES;

/** Request and response body types per route. `undefined` means no body. */
export interface ApiContract {
  health: { body: undefined; response: HealthResponse };
  listQuests: { body: undefined; response: ListQuestsResponse };
  startReview: { body: StartReviewRequest; response: RunResponse };
  approveQuest: { body: ApproveRequest; response: ApproveResponse };
  listRuns: { body: undefined; response: ListRunsResponse };
  getRun: { body: undefined; response: RunResponse };
  postRun: { body: PostReviewRequest; response: PostReviewResponse };
  discardRun: { body: undefined; response: RunResponse };
  getPlayer: { body: undefined; response: PlayerResponse };
  listAchievements: { body: undefined; response: ListAchievementsResponse };
  /** The response is a `text/event-stream`, not JSON; see `ServerEvent`. */
  events: { body: undefined; response: never };
}

type PathParamNames<TPath extends string> = TPath extends `${string}:${infer TParam}/${infer TRest}`
  ? TParam | PathParamNames<`/${TRest}`>
  : TPath extends `${string}:${infer TParam}`
    ? TParam
    : never;

/** Path parameters derived from the route's path pattern, e.g. `{ id: string }`. */
export type RouteParams<TName extends RouteName> = {
  [Key in PathParamNames<(typeof API_ROUTES)[TName]['path']>]: string;
};

export type RequestBody<TName extends RouteName> = ApiContract[TName]['body'];

export type ResponseBody<TName extends RouteName> = ApiContract[TName]['response'];

export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (typeof value !== 'object' || !value || !('error' in value)) {
    return false;
  }
  const { error } = value;
  return (
    typeof error === 'object' &&
    !!error &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

/** Fills a route's path pattern, URL-encoding each parameter. */
export function buildApiPath<TName extends RouteName>(
  name: TName,
  params: RouteParams<TName>,
): string {
  const values: Record<string, string> = params;
  return API_ROUTES[name].path.replace(/:(\w+)/g, (_match, key: string) => {
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    if (typeof value !== 'string') {
      throw new Error(`Missing path parameter "${key}" for route ${name}`);
    }
    return encodeURIComponent(value);
  });
}
