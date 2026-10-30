import type {
  AchievementStatus,
  DifficultyTier,
  PlayerCounters,
  PlayerState,
  RequestKind,
  UnlockedAchievement,
  XpReason,
} from '../shared/api.ts';
import { ACHIEVEMENT_RULES, type AchievementFacts } from './achievements.ts';

export type ReviewActionKind = 'reviewPosted' | 'approved' | 'changesRequested';

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
  /** Local calendar date (`YYYY-MM-DD`) of the latest rewarded action. */
  lastReviewDate?: string;
  /** Quest ids whose approval already earned XP. */
  rewardedApprovals: Array<string>;
}

export interface ReviewAction {
  kind: ReviewActionKind;
  questId: string;
  difficulty: DifficultyTier;
  requestKind: RequestKind;
  requestedAt: string;
  at: Date;
}

export interface XpGrant {
  amount: number;
  reason: XpReason;
  questId?: string;
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

export function localDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function previousLocalDate(date: Date): string {
  return localDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1));
}

/** The streak still counts on the day after the last action, so it can be extended today. */
export function currentStreak(state: GameState, now: Date): number {
  const last = state.lastReviewDate;
  return last === localDate(now) || last === previousLocalDate(now) ? state.streakDays : 0;
}

export function applyReviewAction(state: GameState, action: ReviewAction): GameUpdate {
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
  if (
    action.kind === 'approved' &&
    action.at.getTime() - Date.parse(action.requestedAt) <= QUICK_DRAW_WINDOW_MS
  ) {
    counters.quickDraws++;
  }

  const today = localDate(action.at);
  const next: GameState = {
    ...state,
    xp: state.xp + amount,
    counters,
    streakDays:
      today === state.lastReviewDate ? state.streakDays : currentStreak(state, action.at) + 1,
    lastReviewDate: today,
    rewardedApprovals:
      action.kind === 'approved'
        ? [...state.rewardedApprovals, action.questId]
        : state.rewardedApprovals,
  };
  return withUnlocks(
    next,
    [{ amount, reason: action.kind, questId: action.questId }],
    action.at,
    false,
  );
}

/** An agent review finished with parsed findings. Earns no XP itself; only counts toward achievements. */
export function applyAgentReviewFinished(state: GameState, at: Date): GameUpdate {
  const counters = { ...state.counters, agentReviews: state.counters.agentReviews + 1 };
  return withUnlocks({ ...state, counters }, [], at, false);
}

/** The quest list was refreshed; an empty list can unlock Inbox Zero. */
export function applyQueueChecked(
  state: GameState,
  check: { questCount: number; at: Date },
): GameUpdate {
  const emptyAfterActionToday =
    check.questCount === 0 && state.lastReviewDate === localDate(check.at);
  return withUnlocks(state, [], check.at, emptyAfterActionToday);
}

function withUnlocks(
  state: GameState,
  grants: Array<XpGrant>,
  at: Date,
  queueEmptyAfterActionToday: boolean,
): GameUpdate {
  const facts: AchievementFacts = {
    ...factsFor(state, at),
    queueEmptyAfterActionToday,
  };
  const owned = new Set(state.achievements.map((entry) => entry.id));
  const newlyMet = ACHIEVEMENT_RULES.filter((rule) => !owned.has(rule.def.id) && rule.isMet(facts));
  if (newlyMet.length === 0 && grants.length === 0) {
    return { state, grants: [], unlocked: [], xpGained: 0 };
  }
  const unlocked = newlyMet.map((rule) => ({ id: rule.def.id, unlockedAt: at.toISOString() }));
  const allGrants = [
    ...grants,
    ...newlyMet.map((rule): XpGrant => ({ amount: rule.def.xpReward, reason: 'achievement' })),
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

function factsFor(state: GameState, now: Date): AchievementFacts {
  const { reviewsPosted, approvals, changesRequested } = state.counters;
  return {
    counters: state.counters,
    totalActions: reviewsPosted + approvals + changesRequested,
    streakDays: currentStreak(state, now),
    queueEmptyAfterActionToday: false,
  };
}

export function toPlayerState(state: GameState, now: Date): PlayerState {
  const player: PlayerState = {
    xp: state.xp,
    ...levelProgress(state.xp),
    streakDays: currentStreak(state, now),
    achievements: state.achievements,
    counters: state.counters,
  };
  if (state.lastReviewDate) {
    player.lastReviewDate = state.lastReviewDate;
  }
  return player;
}

export function achievementStatuses(state: GameState, now: Date): Array<AchievementStatus> {
  const facts = factsFor(state, now);
  return ACHIEVEMENT_RULES.map((rule) => {
    const status: AchievementStatus = { ...rule.def };
    const unlockedAt = state.achievements.find((entry) => entry.id === rule.def.id)?.unlockedAt;
    if (unlockedAt) {
      status.unlockedAt = unlockedAt;
    }
    if (rule.progress && rule.def.target !== undefined) {
      status.progress = Math.min(rule.progress(facts), rule.def.target);
    }
    return status;
  });
}
