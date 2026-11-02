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
  /**
   * GitHub's `CommentAuthorAssociation` for the author on this repo (`OWNER`, `MEMBER`,
   * `COLLABORATOR`, `CONTRIBUTOR`, `NONE`, ...), when known.
   */
  authorAssociation?: string;
  /** The source branch lives in a fork rather than the PR's repo, when known. */
  isCrossRepository?: boolean;
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

/**
 * A finding's id is its index in `ReviewResult.findings`. A result never changes once its run has
 * finished, so the index stays stable.
 */
export interface ReviewFinding {
  /** Repository-relative path. */
  file: string;
  /** Line in the new version of the file; omitted for file-level findings. */
  line?: number;
  severity: FindingSeverity;
  /** Markdown. */
  body: string;
}

/** Why a file was left out of the diff Claude reviewed. */
export type OmittedFileReason = 'lockfile' | 'generated' | 'binary' | 'tooLarge';

export interface OmittedFile {
  file: string;
  reason: OmittedFileReason;
}

/** The JSON the review agent must return. The verdict is advisory; the agent never approves. */
export interface ReviewResult {
  summary: string;
  verdict: ReviewVerdict;
  findings: Array<ReviewFinding>;
  /** Files the reviewer never saw; set by the server for Claude reviews, never by the model. */
  omitted?: Array<OmittedFile>;
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
  /** Who reviewed. Runs from before providers existed were all Cursor's. */
  provider: ReviewProvider;
  /** The model id, when one was chosen; Cursor runs without one used Cursor's default. */
  model?: string;
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
  /**
   * The findings the player selected to post, as ascending indexes into `result.findings`. Only
   * selected findings are ever posted. Absent until the player first selects or clears a finding.
   * Fixed once the run is posted, when they are exactly the findings that were posted.
   */
  selectedFindings?: Array<number>;
  error?: ReviewRunError;
  /** GitHub URL of the review created by `POST /api/runs/:id/post`. */
  postedReviewUrl?: string;
}

// ---------------------------------------------------------------------------
// Gamification
// ---------------------------------------------------------------------------

/** Every achievement id; the stored state accepts exactly these. */
export const ACHIEVEMENT_IDS = [
  'first-blood',
  'quick-draw',
  'boss-slayer',
  'team-player',
  'inbox-zero',
  'on-fire',
  'agent-commander',
  'necromancer',
  'early-bird',
  'night-owl',
  'weekend-warrior',
  'centurion-bronze',
  'centurion-silver',
  'centurion-gold',
  'unstoppable',
  'clean-sweep',
  'giant-killer',
  'featherweight',
  'the-long-read',
  'eagle-eye',
  'gatekeeper',
  'second-opinion',
  'explorer',
  'diplomat',
  'bot-wrangler',
  'speedrunner',
  'archaeologist',
] as const;

export type AchievementId = (typeof ACHIEVEMENT_IDS)[number];

/** How hard an achievement is to get; it sets the bonus XP. */
export type AchievementRarity = 'common' | 'rare' | 'epic' | 'legendary';

/** The group the Achievements dialog lists an achievement under. */
export type AchievementCategory = 'milestones' | 'streaks' | 'feats' | 'variety' | 'secret';

export type AchievementTier = 'bronze' | 'silver' | 'gold';

/** The tiers of one achievement, such as Centurion Bronze, Silver and Gold, share a series. */
export interface AchievementSeries {
  id: string;
  name: string;
  tier: AchievementTier;
}

export interface AchievementDef {
  id: AchievementId;
  name: string;
  description: string;
  /** A single emoji or short glyph shown on the badge. */
  icon: string;
  /** Bonus XP, awarded once when the achievement unlocks. */
  xpReward: number;
  rarity?: AchievementRarity;
  category?: AchievementCategory;
  series?: AchievementSeries;
  /** Hidden achievements show as "???" until unlocked. */
  secret?: boolean;
  /** What a hidden achievement shows instead of its description until it unlocks. */
  hint?: string;
  /** Counter target for progress bars, e.g. 10 for Team Player. */
  target?: number;
  /** `progress` counts only today's actions and starts again each local day. */
  daily?: boolean;
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
  /** For an achievement bonus, `xp-achievement-<id>`: the same every time, so it counts once. */
  eventId: string;
  amount: number;
  reason: XpReason;
  questId?: string;
  /** The achievement whose bonus this is, when `reason` is `achievement`. */
  achievementId?: AchievementId;
}

/** Game side effects of an action, returned so the UI can animate without waiting for SSE. */
export interface GameOutcome {
  /** Sum of `gains`. */
  xpGained: number;
  /** The action's award first, then one per unlocked achievement. */
  gains: Array<XpGain>;
  player: PlayerState;
  unlocked: Array<UnlockedAchievement>;
  /**
   * The definitions of `unlocked`, in the same order. The achievement list shows hidden ones as
   * "???", so the UI needs these to announce them.
   */
  achievements?: Array<AchievementDef>;
}

// ---------------------------------------------------------------------------
// GitHub account
// ---------------------------------------------------------------------------

/** `oauth`: the player signed in through PR Quest. `gh`: the token of a logged-in GitHub CLI. */
export type GitHubTokenSource = 'oauth' | 'gh';

/** The GitHub user PR Quest acts as. */
export interface GitHubAccount {
  login: string;
  name?: string;
  avatarUrl?: string;
  tokenSource: GitHubTokenSource;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Who reviews a quest: a Cursor cloud agent, or Claude reading the diff through Anthropic's API. */
export type ReviewProvider = 'cursor' | 'claude';

/** The API keys the settings popup manages. `anthropic` is the Claude provider's key. */
export type ApiKeyName = 'cursor' | 'anthropic' | 'linear';

export const API_KEY_NAMES: ReadonlyArray<ApiKeyName> = ['cursor', 'anthropic', 'linear'];

/** `settings`: saved from the settings popup. `env`: from the environment or `.env.local`, read-only. */
export type ApiKeySource = 'settings' | 'env';

/** What the UI may know about a key. The value itself never leaves the server. */
export interface ApiKeyStatus {
  set: boolean;
  source?: ApiKeySource;
  /** The key's last four characters, only for keys long enough that this reveals little. */
  last4?: string;
}

/**
 * "Sign in with GitHub" through GitHub's device flow. `pending`: waiting for the player to enter
 * `userCode` at `verificationUri`. The server polls GitHub; the UI only reads this status.
 */
export type DeviceFlowState = 'idle' | 'pending' | 'complete' | 'expired' | 'denied' | 'error';

export interface DeviceFlowStatus {
  state: DeviceFlowState;
  userCode?: string;
  verificationUri?: string;
  expiresAt?: string;
  error?: string;
}

export interface ModelOption {
  id: string;
  displayName: string;
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
    anthropicApiKey: boolean;
  };
}

export interface AuthStatusResponse {
  /** Whether "Sign in with GitHub" can work, i.e. an OAuth App client ID is configured. */
  clientIdConfigured: boolean;
  /** The GitHub user PR Quest acts as; absent when there is no usable token. */
  account?: GitHubAccount;
  /** Why the token didn't resolve to a user, e.g. GitHub rejected it. */
  error?: string;
  device: DeviceFlowStatus;
  /**
   * Only on the sign-out reply: the OAuth login that was signed out, when PR Quest now acts as a
   * different account through the gh CLI's token (`account`).
   */
  fellBackFrom?: string;
}

export interface DeviceFlowResponse {
  device: DeviceFlowStatus;
}

export interface SettingsResponse {
  reviewProvider: ReviewProvider;
  /** Model id per provider; absent means the provider's default. */
  models: Partial<Record<ReviewProvider, string>>;
  keys: Record<ApiKeyName, ApiKeyStatus>;
}

export interface UpdateSettingsRequest {
  reviewProvider?: ReviewProvider;
  /** `null` goes back to the provider's default model. */
  models?: Partial<Record<ReviewProvider, string | null>>;
}

export interface SetApiKeyRequest {
  value: string;
}

export interface ListModelsResponse {
  provider: ReviewProvider;
  models: Array<ModelOption>;
  /** `fallback`: the provider couldn't be asked (no key, offline), so this is a built-in list. */
  source: 'api' | 'fallback';
  error?: string;
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
  /** Model id for the selected provider; the model chosen in the settings when omitted. */
  model?: string;
}

export interface RunResponse {
  run: ReviewRun;
}

export interface ListRunsResponse {
  runs: Array<ReviewRun>;
}

export type PostReviewEvent = 'comment' | 'requestChanges';

export interface SelectFindingsRequest {
  /** The findings to select or clear, as indexes into `result.findings`. */
  findingIndexes: Array<number>;
  selected: boolean;
}

export interface PostReviewRequest {
  /** GitHub review event. Defaults to `comment`. Approving is a separate, explicit action. */
  event?: PostReviewEvent;
  /**
   * The selected findings the player confirmed, as indexes into `result.findings`; `[]` posts only
   * the summary. They must be exactly the run's selected findings, or the server posts nothing and
   * answers `conflict`. A request without them is refused with `badRequest` rather than posting
   * every finding, because that could post findings the player left out.
   */
  findingIndexes: Array<number>;
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
  /** HTTP 401: there is no GitHub token; sign in with GitHub (or `gh auth login`) first. */
  | 'notSignedIn'
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
    /** With `missingConfig`: the review provider that needs a key, so the UI can open Settings. */
    provider?: ReviewProvider;
  };
}

// ---------------------------------------------------------------------------
// Route map
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

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
  /** Selects or clears findings of a finished run that is still awaiting a decision. */
  selectFindings: { method: 'PUT', path: '/api/runs/:id/selection' },
  discardRun: { method: 'POST', path: '/api/runs/:id/discard' },
  getPlayer: { method: 'GET', path: '/api/player' },
  listAchievements: { method: 'GET', path: '/api/achievements' },
  authStatus: { method: 'GET', path: '/api/auth/status' },
  /** Starts (or restarts) "Sign in with GitHub". */
  startDeviceFlow: { method: 'POST', path: '/api/auth/device' },
  getDeviceFlow: { method: 'GET', path: '/api/auth/device' },
  cancelDeviceFlow: { method: 'DELETE', path: '/api/auth/device' },
  /** Forgets the OAuth token. A logged-in gh CLI's token still works afterwards. */
  signOut: { method: 'POST', path: '/api/auth/sign-out' },
  getSettings: { method: 'GET', path: '/api/settings' },
  updateSettings: { method: 'PUT', path: '/api/settings' },
  setApiKey: { method: 'PUT', path: '/api/settings/keys/:name' },
  removeApiKey: { method: 'DELETE', path: '/api/settings/keys/:name' },
  /** `?provider=cursor|claude`. */
  listModels: { method: 'GET', path: '/api/settings/models' },
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
  selectFindings: { body: SelectFindingsRequest; response: RunResponse };
  discardRun: { body: undefined; response: RunResponse };
  getPlayer: { body: undefined; response: PlayerResponse };
  listAchievements: { body: undefined; response: ListAchievementsResponse };
  authStatus: { body: undefined; response: AuthStatusResponse };
  startDeviceFlow: { body: undefined; response: DeviceFlowResponse };
  getDeviceFlow: { body: undefined; response: DeviceFlowResponse };
  cancelDeviceFlow: { body: undefined; response: DeviceFlowResponse };
  signOut: { body: undefined; response: AuthStatusResponse };
  getSettings: { body: undefined; response: SettingsResponse };
  updateSettings: { body: UpdateSettingsRequest; response: SettingsResponse };
  setApiKey: { body: SetApiKeyRequest; response: SettingsResponse };
  removeApiKey: { body: undefined; response: SettingsResponse };
  listModels: { body: undefined; response: ListModelsResponse };
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
