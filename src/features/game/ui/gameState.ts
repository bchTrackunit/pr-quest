import type {
  AchievementDef,
  AchievementStatus,
  FindingSeverity,
  ListQuestsResponse,
  PlayerState,
  Quest,
  QuestSource,
  RateLimitStatus,
  ReviewFinding,
  ReviewRun,
  ServerEvent,
  XpReason,
} from '../../../shared/api.ts';
import type { NotificationAccess } from '../../../platform/ui/notifications.ts';
import type { SettingsTarget } from '../../settings/ui/index.ts';

export type LoadState = 'loading' | 'ready' | 'error';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';

export type ToastKind = 'loot' | 'achievement' | 'success' | 'error';

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  message?: string;
  icon?: string;
  /** Achievement toasts: the rarity and bonus XP, e.g. "Rare · +50 bonus XP". */
  reward?: string;
  /** Loot toasts link to the finished run's result. */
  runId?: string;
  href?: string;
}

export interface XpPopup {
  id: string;
  amount: number;
  reason: XpReason;
}

/** An in-flight request started from a quest card, so its buttons can show progress. */
export type QuestAction = 'review' | 'approve';

/** Why a quest card's action failed, and the settings that fix it when there are some. */
export interface QuestActionError {
  message: string;
  settings?: SettingsTarget;
}

export interface GameState {
  quests: Array<Quest>;
  questsLoad: LoadState;
  questsError?: string;
  questsFetchedAt?: string;
  questSource?: QuestSource;
  /** The server is serving quests older than its cache lifetime. */
  questsStale: boolean;
  /** Set while GitHub rate limits the server's quest list. */
  questsRateLimit?: RateLimitStatus;
  runs: Record<string, ReviewRun>;
  /** Loading the runs failed for a reason the quest board doesn't already show. */
  runsError?: string;
  player?: PlayerState;
  playerError?: string;
  achievements: Array<AchievementStatus>;
  achievementsError?: string;
  toasts: Array<Toast>;
  xpPopups: Array<XpPopup>;
  connection: ConnectionStatus;
  questActions: Record<string, QuestAction>;
  questActionErrors: Record<string, QuestActionError>;
  openRunId?: string;
  approveQuestId?: string;
  /** The settings popup is open at this section. */
  settings?: SettingsTarget;
  soundEnabled: boolean;
  notificationsEnabled: boolean;
  notificationAccess: NotificationAccess;
}

export function createInitialGameState(notificationAccess: NotificationAccess): GameState {
  return {
    quests: [],
    questsLoad: 'loading',
    questsStale: false,
    runs: {},
    achievements: [],
    toasts: [],
    xpPopups: [],
    connection: 'connecting',
    questActions: {},
    questActionErrors: {},
    soundEnabled: true,
    notificationsEnabled: notificationAccess === 'granted',
    notificationAccess,
  };
}

export const SEVERITY_ORDER: ReadonlyArray<FindingSeverity> = ['critical', 'major', 'minor', 'nit'];

export const XP_REASON_LABELS: Record<XpReason, string> = {
  reviewPosted: 'Review posted',
  approved: 'PR approved',
  changesRequested: 'Changes requested',
  achievement: 'Achievement bonus',
};

let nextLocalId = 0;

export function createLocalId(prefix: string): string {
  nextLocalId += 1;
  return `${prefix}-${nextLocalId}`;
}

export function upsertRun(state: GameState, run: ReviewRun): GameState {
  return { ...state, runs: { ...state.runs, [run.id]: run } };
}

export function upsertRuns(state: GameState, runs: ReadonlyArray<ReviewRun>): GameState {
  const merged = { ...state.runs };
  for (const run of runs) {
    merged[run.id] = run;
  }
  return { ...state, runs: merged };
}

export function replaceRuns(state: GameState, runs: ReadonlyArray<ReviewRun>): GameState {
  return upsertRuns({ ...state, runs: {} }, runs);
}

/**
 * After signing in or out the server serves another player's game, so everything that belonged
 * to the previous one goes. The connection, sound and notification choices and an open settings
 * popup stay.
 */
export function resetForAccountChange(state: GameState): GameState {
  return {
    ...createInitialGameState(state.notificationAccess),
    connection: state.connection,
    settings: state.settings,
    soundEnabled: state.soundEnabled,
    notificationsEnabled: state.notificationsEnabled,
  };
}

export function markAchievementUnlocked(
  state: GameState,
  achievement: AchievementDef,
  unlockedAt: string,
): GameState {
  const known = state.achievements.some((entry) => entry.id === achievement.id);
  // The list held a hidden achievement as "???"; the unlock brings its real name and icon.
  const achievements = known
    ? state.achievements.map((entry) =>
        entry.id === achievement.id
          ? { ...entry, ...achievement, unlockedAt: entry.unlockedAt ?? unlockedAt }
          : entry,
      )
    : [...state.achievements, { ...achievement, unlockedAt }];
  const player =
    state.player && !state.player.achievements.some((entry) => entry.id === achievement.id)
      ? {
          ...state.player,
          achievements: [...state.player.achievements, { id: achievement.id, unlockedAt }],
        }
      : state.player;
  return { ...state, achievements, player };
}

/** Takes a quest list from `GET /api/quests` or a `questsUpdated` event. */
export function applyQuestList(state: GameState, list: ListQuestsResponse): GameState {
  return {
    ...state,
    quests: list.quests,
    questsFetchedAt: list.fetchedAt,
    questSource: list.source,
    questsStale: list.stale,
    questsRateLimit: list.rateLimit,
    questsLoad: 'ready',
    questsError: undefined,
  };
}

/** The rate limit while it still applies at `now`; `undefined` once it has passed. */
export function activeRateLimit(
  rateLimit: RateLimitStatus | undefined,
  now: number,
): RateLimitStatus | undefined {
  return rateLimit && Date.parse(rateLimit.limitedUntil) > now ? rateLimit : undefined;
}

/** Applies the data part of a server event. Side effects (toasts, sounds) live in the controller. */
export function applyServerEvent(state: GameState, event: ServerEvent): GameState {
  switch (event.type) {
    case 'questsUpdated':
      return applyQuestList(state, event);
    case 'runUpdated':
      return upsertRun(state, event.run);
    case 'achievementUnlocked':
      return markAchievementUnlocked(state, event.achievement, event.unlockedAt);
    case 'xpGained':
      return { ...state, player: event.player };
    default:
      return state;
  }
}

function isDismissed(run: ReviewRun): boolean {
  return run.disposition === 'discarded';
}

/**
 * The run a quest card reflects: the server's `activeRunId` when known, otherwise the newest
 * run for the quest. Discarded runs are hidden so the card returns to its idle state.
 */
export function selectRunForQuest(
  runs: Readonly<Partial<Record<string, ReviewRun>>>,
  quest: Quest,
): ReviewRun | undefined {
  const active = quest.activeRunId ? runs[quest.activeRunId] : undefined;
  const newest = Object.values(runs)
    .filter((run): run is ReviewRun => run?.questId === quest.id)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .at(0);
  const candidate =
    active && newest && newest.startedAt > active.startedAt ? newest : (active ?? newest);
  return candidate && !isDismissed(candidate) ? candidate : undefined;
}

/** Direct requests first, then `needsAttention`, then the longest-waiting request. */
export function sortQuests(quests: ReadonlyArray<Quest>): Array<Quest> {
  return [...quests].sort((left, right) => {
    if (left.requestKind !== right.requestKind) {
      return left.requestKind === 'direct' ? -1 : 1;
    }
    if (left.needsAttention !== right.needsAttention) {
      return left.needsAttention ? -1 : 1;
    }
    return left.requestedAt.localeCompare(right.requestedAt);
  });
}

export interface FindingGroup {
  severity: FindingSeverity;
  findings: Array<ReviewFinding>;
}

export function groupFindings(findings: ReadonlyArray<ReviewFinding>): Array<FindingGroup> {
  return SEVERITY_ORDER.map((severity) => ({
    severity,
    findings: findings.filter((finding) => finding.severity === severity),
  })).filter((group) => group.findings.length > 0);
}

export function questLabel(quest: Pick<Quest, 'repo' | 'number'>): string {
  return `${quest.repo.owner}/${quest.repo.name}#${quest.number}`;
}

export function findQuest(state: GameState, questId: string | undefined): Quest | undefined {
  return questId ? state.quests.find((quest) => quest.id === questId) : undefined;
}
