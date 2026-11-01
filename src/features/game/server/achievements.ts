import type {
  AchievementDef,
  AchievementId,
  AchievementRarity,
  DifficultyTier,
  PlayerCounters,
} from '../../../shared/api.ts';
import type { AchievementLedger } from './ledger.ts';

export type ReviewActionKind = 'reviewPosted' | 'approved' | 'changesRequested';

/** Bonus XP for unlocking an achievement of each rarity. */
export const RARITY_XP: Record<AchievementRarity, number> = {
  common: 25,
  rare: 50,
  epic: 100,
  legendary: 200,
};

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const NECROMANCER_WAIT_MS = 30 * DAY_MS;
export const SPEEDRUN_WINDOW_MS = 5 * MINUTE_MS;
export const LONG_READ_LINES = 2000;
const EARLY_BIRD_BEFORE_HOUR = 8;
const NIGHT_OWL_FROM_HOUR = 22;

/** The review action being rewarded, as the rules see it. */
export interface ActionFacts {
  kind: ReviewActionKind;
  at: Date;
  difficulty: DifficultyTier;
  /** How long the PR had waited since `requestedAt`. */
  waitedMs: number;
  /** Additions plus deletions, when the quest's diff stats are known. */
  changedLines?: number;
  /** The PR had a posted review or a finished agent review before this action. */
  wasReviewedBefore: boolean;
  /** The quest was on the board and no other quest there had waited longer. */
  wasOldestOnBoard: boolean;
  /** The board had no other direct request left. */
  clearedDirectRequests: boolean;
}

/** What an achievement rule can see when it is evaluated. */
export interface AchievementFacts {
  counters: PlayerCounters;
  ledger: AchievementLedger;
  /** Rewarded review actions of any kind. */
  totalActions: number;
  streakDays: number;
  /** The quest list just came back empty on a day with at least one rewarded action. */
  queueEmptyAfterActionToday: boolean;
  /** Today's counters, or zeros when the last action was on another day. */
  today: { trivialApprovals: number; directPrs: number };
  /** Set only while a review action is being applied. */
  action?: ActionFacts;
}

export interface AchievementRule {
  def: AchievementDef;
  /** Counter toward `def.target`; only for achievements with a target. */
  progress?: (facts: AchievementFacts) => number;
  isMet: (facts: AchievementFacts) => boolean;
}

type RuleDef = Omit<AchievementDef, 'xpReward' | 'rarity'> & { rarity: AchievementRarity };

function define(def: RuleDef): AchievementDef {
  return { ...def, xpReward: RARITY_XP[def.rarity] };
}

function counted(
  def: RuleDef & { target: number },
  count: (facts: AchievementFacts) => number,
): AchievementRule {
  const target = def.target;
  return { def: define(def), progress: count, isMet: (facts) => count(facts) >= target };
}

function onAction(def: RuleDef, isMet: (action: ActionFacts) => boolean): AchievementRule {
  return { def: define(def), isMet: (facts) => facts.action !== undefined && isMet(facts.action) };
}

function centurion(
  tier: 'bronze' | 'silver' | 'gold',
  name: string,
  target: number,
  rarity: AchievementRarity,
): AchievementRule {
  return counted(
    {
      id: `centurion-${tier}`,
      name: `Centurion ${name}`,
      description: `Complete ${target} review actions.`,
      icon: '🛡️',
      rarity,
      category: 'milestones',
      series: { id: 'centurion', name: 'Centurion', tier },
      target,
    },
    (facts) => facts.totalActions,
  );
}

const hasBothProviders = (ledger: AchievementLedger): boolean =>
  Object.values(ledger.runProviders).some(
    (providers) => providers.includes('cursor') && providers.includes('claude'),
  );

/** Every achievement, in display order. Add new ones here; the UI renders whatever this lists. */
export const ACHIEVEMENT_RULES: ReadonlyArray<AchievementRule> = [
  counted(
    {
      id: 'first-blood',
      name: 'First Blood',
      description: 'Post a review, request changes or approve for the first time.',
      icon: '🩸',
      rarity: 'common',
      category: 'milestones',
      target: 1,
    },
    (facts) => facts.totalActions,
  ),
  centurion('bronze', 'Bronze', 10, 'common'),
  centurion('silver', 'Silver', 50, 'rare'),
  centurion('gold', 'Gold', 100, 'legendary'),
  counted(
    {
      id: 'team-player',
      name: 'Team Player',
      description: 'Complete 10 review actions on PRs requested from one of your teams.',
      icon: '🤝',
      rarity: 'rare',
      category: 'milestones',
      target: 10,
    },
    (facts) => facts.counters.teamReviews,
  ),
  counted(
    {
      id: 'agent-commander',
      name: 'Agent Commander',
      description: 'Have 10 agent reviews finish.',
      icon: '🤖',
      rarity: 'rare',
      category: 'milestones',
      target: 10,
    },
    (facts) => facts.counters.agentReviews,
  ),
  counted(
    {
      id: 'gatekeeper',
      name: 'Gatekeeper',
      description: 'Request changes on 5 different PRs.',
      icon: '🚧',
      rarity: 'rare',
      category: 'milestones',
      target: 5,
    },
    (facts) => facts.ledger.changesRequestedPrs.length,
  ),
  counted(
    {
      id: 'giant-killer',
      name: 'Giant Killer',
      description: 'Approve 5 Boss-tier PRs.',
      icon: '🗡️',
      rarity: 'epic',
      category: 'milestones',
      target: 5,
    },
    (facts) => facts.ledger.bossApprovals,
  ),
  counted(
    {
      id: 'on-fire',
      name: 'On Fire',
      description: 'Review something five days in a row.',
      icon: '🔥',
      rarity: 'epic',
      category: 'streaks',
      target: 5,
    },
    (facts) => facts.streakDays,
  ),
  counted(
    {
      id: 'unstoppable',
      name: 'Unstoppable',
      description: 'Review something seven days in a row.',
      icon: '☄️',
      rarity: 'legendary',
      category: 'streaks',
      target: 7,
    },
    (facts) => facts.streakDays,
  ),
  onAction(
    {
      id: 'early-bird',
      name: 'Early Bird',
      description: 'Complete a review action before 08:00.',
      icon: '🐦',
      rarity: 'common',
      category: 'streaks',
    },
    (action) => action.at.getHours() < EARLY_BIRD_BEFORE_HOUR,
  ),
  onAction(
    {
      id: 'night-owl',
      name: 'Night Owl',
      description: 'Complete a review action at 22:00 or later.',
      icon: '🦉',
      rarity: 'common',
      category: 'streaks',
    },
    (action) => action.at.getHours() >= NIGHT_OWL_FROM_HOUR,
  ),
  onAction(
    {
      id: 'weekend-warrior',
      name: 'Weekend Warrior',
      description: 'Complete a review action on a Saturday or Sunday.',
      icon: '🏖️',
      rarity: 'common',
      category: 'streaks',
    },
    (action) => action.at.getDay() === 0 || action.at.getDay() === 6,
  ),
  {
    def: define({
      id: 'quick-draw',
      name: 'Quick Draw',
      description: 'Approve a PR within an hour of being asked to review it.',
      icon: '⚡',
      rarity: 'rare',
      category: 'feats',
    }),
    isMet: (facts) => facts.counters.quickDraws > 0,
  },
  {
    def: define({
      id: 'boss-slayer',
      name: 'Boss Slayer',
      description: 'Post a review on, or approve, a Boss-tier PR.',
      icon: '🐉',
      rarity: 'rare',
      category: 'feats',
    }),
    isMet: (facts) => facts.counters.bossesSlain > 0,
  },
  {
    def: define({
      id: 'inbox-zero',
      name: 'Inbox Zero',
      description: 'Clear your review queue on a day you reviewed something.',
      icon: '📭',
      rarity: 'rare',
      category: 'feats',
    }),
    isMet: (facts) => facts.queueEmptyAfterActionToday,
  },
  {
    def: define({
      id: 'clean-sweep',
      name: 'Clean Sweep',
      description: 'Act on 5 direct requests in a day and leave none waiting.',
      icon: '🧹',
      rarity: 'epic',
      category: 'feats',
      target: 5,
      daily: true,
    }),
    progress: (facts) => facts.today.directPrs,
    isMet: (facts) => facts.action?.clearedDirectRequests === true && facts.today.directPrs >= 5,
  },
  onAction(
    {
      id: 'necromancer',
      name: 'Necromancer',
      description: 'Review a PR that has waited 30 days or more.',
      icon: '🧟',
      rarity: 'rare',
      category: 'feats',
    },
    (action) => action.waitedMs >= NECROMANCER_WAIT_MS,
  ),
  onAction(
    {
      id: 'the-long-read',
      name: 'The Long Read',
      description: 'Review a PR with 2,000 or more changed lines.',
      icon: '📜',
      rarity: 'rare',
      category: 'feats',
    },
    (action) => (action.changedLines ?? 0) >= LONG_READ_LINES,
  ),
  {
    def: define({
      id: 'eagle-eye',
      name: 'Eagle Eye',
      description: 'Post a review with at least one accepted critical or major finding.',
      icon: '🦅',
      rarity: 'common',
      category: 'feats',
    }),
    isMet: (facts) => facts.ledger.highSeverityReviews > 0,
  },
  {
    def: define({
      id: 'featherweight',
      name: 'Featherweight',
      description:
        'Approve 10 Trivial PRs in one day, each after posting a review or finishing an agent review on it.',
      icon: '🪶',
      rarity: 'rare',
      category: 'feats',
      target: 10,
      daily: true,
    }),
    progress: (facts) => facts.today.trivialApprovals,
    isMet: (facts) => facts.today.trivialApprovals >= 10,
  },
  {
    def: define({
      id: 'second-opinion',
      name: 'Second Opinion',
      description: 'Have both a Claude and a Cursor review finish on the same PR.',
      icon: '🩺',
      rarity: 'rare',
      category: 'feats',
    }),
    isMet: (facts) => hasBothProviders(facts.ledger),
  },
  counted(
    {
      id: 'explorer',
      name: 'Explorer',
      description: 'Complete review actions in 10 different repos.',
      icon: '🧭',
      rarity: 'rare',
      category: 'variety',
      target: 10,
    },
    (facts) => facts.ledger.repos.length,
  ),
  counted(
    {
      id: 'diplomat',
      name: 'Diplomat',
      description:
        'Complete review actions on PRs from 10 different people, not counting yourself or bots.',
      icon: '🕊️',
      rarity: 'rare',
      category: 'variety',
      target: 10,
    },
    (facts) => facts.ledger.authors.length,
  ),
  counted(
    {
      id: 'bot-wrangler',
      name: 'Bot Wrangler',
      description: 'Complete review actions on 10 PRs by Dependabot or Renovate.',
      icon: '🤠',
      rarity: 'rare',
      category: 'variety',
      target: 10,
    },
    (facts) => facts.ledger.botPrs.length,
  ),
  onAction(
    {
      id: 'speedrunner',
      name: 'Speedrunner',
      description:
        'Approve a PR within 5 minutes of it opening, after posting a review or finishing an agent review on it.',
      icon: '⏱️',
      rarity: 'epic',
      category: 'secret',
      secret: true,
      hint: 'Some quests reward a very fast hand.',
    },
    (action) =>
      action.kind === 'approved' &&
      action.wasReviewedBefore &&
      action.waitedMs <= SPEEDRUN_WINDOW_MS,
  ),
  onAction(
    {
      id: 'archaeologist',
      name: 'Archaeologist',
      description: 'Complete a review action on the quest that has waited longest on your board.',
      icon: '🏺',
      rarity: 'rare',
      category: 'secret',
      secret: true,
      hint: 'Something on your board has been gathering dust.',
    },
    (action) => action.wasOldestOnBoard,
  ),
];

export function achievementDef(id: AchievementId): AchievementDef | undefined {
  return ACHIEVEMENT_RULES.find((rule) => rule.def.id === id)?.def;
}
