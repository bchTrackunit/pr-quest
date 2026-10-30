import type { AchievementDef, AchievementId, PlayerCounters } from '../shared/api.ts';

/** What an achievement rule can see when it is evaluated. */
export interface AchievementFacts {
  counters: PlayerCounters;
  /** Rewarded review actions of any kind. */
  totalActions: number;
  streakDays: number;
  /** The quest list just came back empty on a day with at least one rewarded action. */
  queueEmptyAfterActionToday: boolean;
}

export interface AchievementRule {
  def: AchievementDef;
  /** Counter toward `def.target`; only for achievements with a target. */
  progress?: (facts: AchievementFacts) => number;
  isMet: (facts: AchievementFacts) => boolean;
}

function counted(
  def: AchievementDef & { target: number },
  count: (facts: AchievementFacts) => number,
): AchievementRule {
  return { def, progress: count, isMet: (facts) => count(facts) >= def.target };
}

/** Every achievement, in display order. Add new ones here; the UI renders whatever this lists. */
export const ACHIEVEMENT_RULES: ReadonlyArray<AchievementRule> = [
  counted(
    {
      id: 'first-blood',
      name: 'First Blood',
      description: 'Post a review, request changes or approve for the first time.',
      icon: '🩸',
      xpReward: 10,
      target: 1,
    },
    (facts) => facts.totalActions,
  ),
  {
    def: {
      id: 'quick-draw',
      name: 'Quick Draw',
      description: 'Approve a PR within an hour of being asked to review it.',
      icon: '⚡',
      xpReward: 25,
    },
    isMet: (facts) => facts.counters.quickDraws > 0,
  },
  {
    def: {
      id: 'boss-slayer',
      name: 'Boss Slayer',
      description: 'Post a review on, or approve, a Boss-tier PR.',
      icon: '🐉',
      xpReward: 50,
    },
    isMet: (facts) => facts.counters.bossesSlain > 0,
  },
  counted(
    {
      id: 'team-player',
      name: 'Team Player',
      description: 'Complete 10 review actions on PRs requested from one of your teams.',
      icon: '🤝',
      xpReward: 40,
      target: 10,
    },
    (facts) => facts.counters.teamReviews,
  ),
  {
    def: {
      id: 'inbox-zero',
      name: 'Inbox Zero',
      description: 'Clear your review queue on a day you reviewed something.',
      icon: '📭',
      xpReward: 30,
    },
    isMet: (facts) => facts.queueEmptyAfterActionToday,
  },
  counted(
    {
      id: 'on-fire',
      name: 'On Fire',
      description: 'Review something five days in a row.',
      icon: '🔥',
      xpReward: 75,
      target: 5,
    },
    (facts) => facts.streakDays,
  ),
  counted(
    {
      id: 'agent-commander',
      name: 'Agent Commander',
      description: 'Have 10 agent reviews finish.',
      icon: '🤖',
      xpReward: 40,
      target: 10,
    },
    (facts) => facts.counters.agentReviews,
  ),
];

export function achievementDef(id: AchievementId): AchievementDef | undefined {
  return ACHIEVEMENT_RULES.find((rule) => rule.def.id === id)?.def;
}
