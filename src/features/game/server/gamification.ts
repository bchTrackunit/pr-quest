import type {
  AchievementDef,
  AchievementId,
  AchievementStatus,
  DiffStats,
  DifficultyTier,
  FindingSeverity,
  PlayerCounters,
  PlayerState,
  Quest,
  QuestAuthor,
  RequestKind,
  ReviewProvider,
  UnlockedAchievement,
  XpReason,
} from '../../../shared/api.ts';
import { machineTimeZone, previousDate, zonedTime } from '../../../platform/server/timeZone.ts';
import {
  ACHIEVEMENT_RULES,
  type AchievementFacts,
  type ActionFacts,
  type ReviewActionKind,
} from './achievements.ts';
import {
  authorKey,
  emptyLedger,
  isAnyBot,
  isBotAuthor,
  isHighSeverity,
  prKey,
  repoKey,
  withEntry,
  withRunProvider,
  type AchievementLedger,
  type DayLedger,
} from './ledger.ts';

export type { ReviewActionKind } from './achievements.ts';

export const ACTION_BASE_XP: Record<ReviewActionKind, number> = {
  reviewPosted: 20,
  approved: 15,
  changesRequested: 15,
};

export const TIER_MULTIPLIERS: Record<DifficultyTier, number> = {
  Trivial: 1,
  Normal: 1.5,
  Hard: 2,
  Boss: 3,
};

export const QUICK_DRAW_WINDOW_MS = 60 * 60 * 1000;

const ACTION_COUNTERS: Record<ReviewActionKind, keyof PlayerCounters> = {
  reviewPosted: 'reviewsPosted',
  approved: 'approvals',
  changesRequested: 'changesRequested',
};

/** Everything the game persists. `PlayerState` is derived from it. */
export interface GameState {
  xp: number;
  achievements: Array<UnlockedAchievement>;
  counters: PlayerCounters;
  /** Streak as of `lastReviewDate`; see `currentStreak` for the value shown today. */
  streakDays: number;
  /** Calendar date (`YYYY-MM-DD`) of the latest rewarded action, in the player's time zone. */
  lastReviewDate?: string;
  /** Quest ids whose approval already earned XP. */
  rewardedApprovals: Array<string>;
  ledger: AchievementLedger;
}

/** A quest as the board showed it when the player acted. */
export type BoardQuest = Pick<Quest, 'id' | 'requestedAt' | 'requestKind'>;

export interface ReviewAction {
  kind: ReviewActionKind;
  questId: string;
  difficulty: DifficultyTier;
  requestKind: RequestKind;
  requestedAt: string;
  at: Date;
  /** Absent for quests saved before PR Quest kept the author. */
  author?: QuestAuthor;
  diffStats?: Pick<DiffStats, 'additions' | 'deletions'>;
  /** The severities of the findings a posted review carried: the accepted ones only. */
  postedSeverities?: Array<FindingSeverity>;
  /** Every quest on the board when the player acted, this one included; absent when unknown. */
  board?: Array<BoardQuest>;
}

/** Who is playing, so their own PRs don't count toward Diplomat, and where. */
export interface PlayerContext {
  login?: string;
  /**
   * The IANA zone whose calendar days and clock hours streaks, daily counters and time-of-day
   * achievements follow. Defaults to the machine's zone, which is the player's in local mode.
   */
  timeZone?: string;
}

const zoneOf = (player: PlayerContext): string | undefined => player.timeZone ?? machineTimeZone();

export interface FinishedReview {
  questId: string;
  provider: ReviewProvider;
}

export interface XpGrant {
  amount: number;
  reason: XpReason;
  questId?: string;
  achievementId?: AchievementId;
}

export interface GameUpdate {
  state: GameState;
  grants: Array<XpGrant>;
  unlocked: Array<UnlockedAchievement>;
  xpGained: number;
}

export function initialGameState(): GameState {
  return {
    xp: 0,
    achievements: [],
    counters: {
      reviewsPosted: 0,
      approvals: 0,
      changesRequested: 0,
      agentReviews: 0,
      teamReviews: 0,
      bossesSlain: 0,
      quickDraws: 0,
    },
    streakDays: 0,
    rewardedApprovals: [],
    ledger: emptyLedger(),
  };
}

/** XP needed to go from `level` to `level + 1`. */
export function xpForLevel(level: number): number {
  return Math.round(100 * level ** 1.5);
}

export function levelProgress(
  xp: number,
): Pick<PlayerState, 'level' | 'xpIntoLevel' | 'xpForNextLevel'> {
  let level = 1;
  let remaining = Math.max(0, xp);
  while (remaining >= xpForLevel(level)) {
    remaining -= xpForLevel(level);
    level++;
  }
  return { level, xpIntoLevel: remaining, xpForNextLevel: xpForLevel(level) };
}

/** The calendar date (`YYYY-MM-DD`) of `date` in `timeZone`. */
export function localDate(date: Date, timeZone: string | undefined = machineTimeZone()): string {
  return zonedTime(date, timeZone).date;
}

/** The streak still counts on the day after the last action, so it can be extended today. */
export function currentStreak(
  state: GameState,
  now: Date,
  timeZone: string | undefined = machineTimeZone(),
): number {
  const last = state.lastReviewDate;
  const today = localDate(now, timeZone);
  return last === today || last === previousDate(today) ? state.streakDays : 0;
}

export function applyReviewAction(
  state: GameState,
  action: ReviewAction,
  player: PlayerContext = {},
): GameUpdate {
  const alreadyApproved =
    action.kind === 'approved' && state.rewardedApprovals.includes(action.questId);
  if (alreadyApproved) {
    return { state, grants: [], unlocked: [], xpGained: 0 };
  }

  const amount = Math.round(ACTION_BASE_XP[action.kind] * TIER_MULTIPLIERS[action.difficulty]);
  const counters = { ...state.counters };
  counters[ACTION_COUNTERS[action.kind]]++;
  if (action.requestKind === 'team') {
    counters.teamReviews++;
  }
  if (action.difficulty === 'Boss') {
    counters.bossesSlain++;
  }
  const waitedMs = action.at.getTime() - Date.parse(action.requestedAt);
  if (action.kind === 'approved' && waitedMs <= QUICK_DRAW_WINDOW_MS) {
    counters.quickDraws++;
  }

  const timeZone = zoneOf(player);
  const facts = actionFacts(state.ledger, action, waitedMs, timeZone);
  const today = facts.local.date;
  const next: GameState = {
    ...state,
    xp: state.xp + amount,
    counters,
    streakDays:
      today === state.lastReviewDate
        ? state.streakDays
        : currentStreak(state, action.at, timeZone) + 1,
    lastReviewDate: today,
    rewardedApprovals:
      action.kind === 'approved'
        ? [...state.rewardedApprovals, action.questId]
        : state.rewardedApprovals,
    ledger: recordAction(state.ledger, action, facts, today, player),
  };
  const grants: Array<XpGrant> = [{ amount, reason: action.kind, questId: action.questId }];
  return withUnlocks(next, grants, action.at, timeZone, { action: facts });
}

function actionFacts(
  ledger: AchievementLedger,
  action: ReviewAction,
  waitedMs: number,
  timeZone: string | undefined,
): ActionFacts {
  const facts: ActionFacts = {
    kind: action.kind,
    at: action.at,
    local: zonedTime(action.at, timeZone),
    difficulty: action.difficulty,
    waitedMs,
    wasReviewedBefore: ledger.reviewedPrs.includes(prKey(action.questId)),
    wasOldestOnBoard: isOldestOnBoard(action),
    clearedDirectRequests:
      action.board !== undefined &&
      !action.board.some((quest) => quest.requestKind === 'direct' && quest.id !== action.questId),
  };
  if (action.diffStats) {
    facts.changedLines = action.diffStats.additions + action.diffStats.deletions;
  }
  return facts;
}

function isOldestOnBoard({ board, questId }: ReviewAction): boolean {
  const own = board?.find((quest) => quest.id === questId);
  if (!board || !own) {
    return false;
  }
  const ownRequestedAt = Date.parse(own.requestedAt);
  return board.every(
    (quest) => quest.id === questId || Date.parse(quest.requestedAt) >= ownRequestedAt,
  );
}

function recordAction(
  ledger: AchievementLedger,
  action: ReviewAction,
  facts: ActionFacts,
  today: string,
  player: PlayerContext,
): AchievementLedger {
  const key = prKey(action.questId);
  const next: AchievementLedger = {
    ...ledger,
    repos: withEntry(ledger.repos, repoKey(action.questId)),
  };
  const author = authorKey(action.author);
  if (author && author !== player.login?.toLowerCase() && !isAnyBot(action.author)) {
    next.authors = withEntry(ledger.authors, author);
  }
  if (author && isBotAuthor(author)) {
    next.botPrs = withEntry(ledger.botPrs, key);
  }
  if (action.kind === 'approved' && action.difficulty === 'Boss') {
    next.bossApprovals = ledger.bossApprovals + 1;
  }
  if (action.kind !== 'approved') {
    next.reviewedPrs = withEntry(ledger.reviewedPrs, key);
  }
  if (action.kind === 'changesRequested') {
    next.changesRequestedPrs = withEntry(ledger.changesRequestedPrs, key);
  }
  if (action.postedSeverities?.some(isHighSeverity)) {
    next.highSeverityReviews = ledger.highSeverityReviews + 1;
  }

  const day: DayLedger =
    ledger.day?.date === today ? ledger.day : { date: today, trivialApprovals: 0, directPrs: [] };
  const featherweight =
    action.kind === 'approved' && action.difficulty === 'Trivial' && facts.wasReviewedBefore;
  next.day = {
    date: today,
    trivialApprovals: day.trivialApprovals + (featherweight ? 1 : 0),
    directPrs: action.requestKind === 'direct' ? withEntry(day.directPrs, key) : [...day.directPrs],
  };
  return next;
}

/** An agent review finished with parsed findings. Earns no XP itself; only counts toward achievements. */
export function applyAgentReviewFinished(
  state: GameState,
  review: FinishedReview,
  at: Date,
  player: PlayerContext = {},
): GameUpdate {
  const key = prKey(review.questId);
  const counters = { ...state.counters, agentReviews: state.counters.agentReviews + 1 };
  const ledger: AchievementLedger = {
    ...state.ledger,
    reviewedPrs: withEntry(state.ledger.reviewedPrs, key),
    runProviders: withRunProvider(state.ledger.runProviders, key, review.provider),
  };
  return withUnlocks({ ...state, counters, ledger }, [], at, zoneOf(player));
}

/** The quest list was refreshed; an empty list can unlock Inbox Zero. */
export function applyQueueChecked(
  state: GameState,
  check: { questCount: number; at: Date },
  player: PlayerContext = {},
): GameUpdate {
  const timeZone = zoneOf(player);
  const emptyAfterActionToday =
    check.questCount === 0 && state.lastReviewDate === localDate(check.at, timeZone);
  return withUnlocks(state, [], check.at, timeZone, {
    queueEmptyAfterActionToday: emptyAfterActionToday,
  });
}

function withUnlocks(
  state: GameState,
  grants: Array<XpGrant>,
  at: Date,
  timeZone: string | undefined,
  extra: Partial<Pick<AchievementFacts, 'action' | 'queueEmptyAfterActionToday'>> = {},
): GameUpdate {
  const facts: AchievementFacts = { ...factsFor(state, at, timeZone), ...extra };
  const owned = new Set(state.achievements.map((entry) => entry.id));
  const newlyMet = ACHIEVEMENT_RULES.filter((rule) => !owned.has(rule.def.id) && rule.isMet(facts));
  if (newlyMet.length === 0 && grants.length === 0) {
    return { state, grants: [], unlocked: [], xpGained: 0 };
  }
  const unlocked = newlyMet.map((rule) => ({ id: rule.def.id, unlockedAt: at.toISOString() }));
  const allGrants = [
    ...grants,
    ...newlyMet.map((rule): XpGrant => ({
      amount: rule.def.xpReward,
      reason: 'achievement',
      achievementId: rule.def.id,
    })),
  ];
  const achievementXp = newlyMet.reduce((sum, rule) => sum + rule.def.xpReward, 0);
  return {
    state: {
      ...state,
      xp: state.xp + achievementXp,
      achievements: [...state.achievements, ...unlocked],
    },
    grants: allGrants,
    unlocked,
    xpGained: allGrants.reduce((sum, grant) => sum + grant.amount, 0),
  };
}

function factsFor(state: GameState, now: Date, timeZone: string | undefined): AchievementFacts {
  const { reviewsPosted, approvals, changesRequested } = state.counters;
  const day = state.ledger.day?.date === localDate(now, timeZone) ? state.ledger.day : undefined;
  return {
    counters: state.counters,
    ledger: state.ledger,
    totalActions: reviewsPosted + approvals + changesRequested,
    streakDays: currentStreak(state, now, timeZone),
    queueEmptyAfterActionToday: false,
    today: { trivialApprovals: day?.trivialApprovals ?? 0, directPrs: day?.directPrs.length ?? 0 },
  };
}

export function toPlayerState(
  state: GameState,
  now: Date,
  context: PlayerContext = {},
): PlayerState {
  const player: PlayerState = {
    xp: state.xp,
    ...levelProgress(state.xp),
    streakDays: currentStreak(state, now, zoneOf(context)),
    achievements: state.achievements,
    counters: state.counters,
  };
  if (state.lastReviewDate) {
    player.lastReviewDate = state.lastReviewDate;
  }
  return player;
}

/** What the player may see of a hidden achievement before unlocking it. */
function redacted(def: AchievementDef): AchievementDef {
  return {
    ...def,
    name: '???',
    description: def.hint ?? 'A secret achievement.',
    icon: '❔',
  };
}

export function achievementStatuses(
  state: GameState,
  now: Date,
  player: PlayerContext = {},
): Array<AchievementStatus> {
  const facts = factsFor(state, now, zoneOf(player));
  return ACHIEVEMENT_RULES.map((rule) => {
    const unlockedAt = state.achievements.find((entry) => entry.id === rule.def.id)?.unlockedAt;
    const status: AchievementStatus =
      rule.def.secret && !unlockedAt ? { ...redacted(rule.def) } : { ...rule.def };
    if (unlockedAt) {
      status.unlockedAt = unlockedAt;
    }
    if (rule.progress && rule.def.target !== undefined) {
      status.progress = Math.min(rule.progress(facts), rule.def.target);
    }
    return status;
  });
}
