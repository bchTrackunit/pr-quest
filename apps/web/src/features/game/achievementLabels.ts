import type {
  AchievementCategory,
  AchievementDef,
  AchievementRarity,
} from '@pr-quest/contract/api';

export const RARITY_LABELS: Record<AchievementRarity, string> = {
  common: 'Common',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
};

export const CATEGORY_LABELS: Record<AchievementCategory, string> = {
  milestones: 'Milestones',
  streaks: 'Streaks and schedule',
  feats: 'Feats',
  variety: 'Variety',
  secret: 'Secret',
};

export const CATEGORY_ORDER: ReadonlyArray<AchievementCategory> = [
  'milestones',
  'streaks',
  'feats',
  'variety',
  'secret',
];

/** "Rare · +50 bonus XP", or just the XP for an achievement without a rarity. */
export function rewardLabel(achievement: Pick<AchievementDef, 'rarity' | 'xpReward'>): string {
  const xp = `+${achievement.xpReward} bonus XP`;
  return achievement.rarity ? `${RARITY_LABELS[achievement.rarity]} · ${xp}` : xp;
}
