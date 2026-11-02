// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import type { AchievementStatus } from '@pr-quest/contract/api';
import { AchievementsPanel } from './AchievementsPanel.tsx';

const UNLOCKED_AT = '2026-10-30T10:00:00.000Z';

const centurion = (
  tier: 'bronze' | 'silver' | 'gold',
  target: number,
  rarity: 'common' | 'rare' | 'legendary',
  xpReward: number,
  unlockedAt?: string,
): AchievementStatus => ({
  id: `centurion-${tier}`,
  name: `Centurion ${tier[0]?.toUpperCase()}${tier.slice(1)}`,
  description: `Complete ${target} review actions.`,
  icon: '🛡️',
  xpReward,
  rarity,
  category: 'milestones',
  series: { id: 'centurion', name: 'Centurion', tier },
  target,
  progress: Math.min(12, target),
  ...(unlockedAt ? { unlockedAt } : {}),
});

const SPEEDRUNNER: AchievementStatus = {
  id: 'speedrunner',
  name: '???',
  description: 'Some quests reward a very fast hand.',
  hint: 'Some quests reward a very fast hand.',
  icon: '❔',
  xpReward: 100,
  rarity: 'epic',
  category: 'secret',
  secret: true,
};

const ACHIEVEMENTS: Array<AchievementStatus> = [
  {
    id: 'first-blood',
    name: 'First Blood',
    description: 'Post a review, request changes or approve for the first time.',
    icon: '🩸',
    xpReward: 25,
    rarity: 'common',
    category: 'milestones',
    target: 1,
    progress: 1,
    unlockedAt: UNLOCKED_AT,
  },
  centurion('bronze', 10, 'common', 25, UNLOCKED_AT),
  centurion('silver', 50, 'rare', 50),
  centurion('gold', 100, 'legendary', 200),
  {
    id: 'featherweight',
    name: 'Featherweight',
    description: 'Approve 10 Trivial PRs in one day.',
    icon: '🪶',
    xpReward: 50,
    rarity: 'rare',
    category: 'feats',
    target: 10,
    progress: 4,
    daily: true,
  },
  {
    id: 'explorer',
    name: 'Explorer',
    description: 'Complete review actions in 10 different repos.',
    icon: '🧭',
    xpReward: 50,
    rarity: 'rare',
    category: 'variety',
    target: 10,
    progress: 3,
  },
  SPEEDRUNNER,
  {
    id: 'archaeologist',
    name: 'Archaeologist',
    description: 'Complete a review action on the quest that has waited longest on your board.',
    hint: 'Something on your board has been gathering dust.',
    icon: '🏺',
    xpReward: 50,
    rarity: 'rare',
    category: 'secret',
    secret: true,
    unlockedAt: UNLOCKED_AT,
  },
];

function renderPanel(achievements: Array<AchievementStatus> = ACHIEVEMENTS) {
  render(<AchievementsPanel achievements={achievements} onClickClose={() => undefined} />);
  return screen.getByRole('dialog');
}

const groupNamed = (name: string) => screen.getByRole('region', { name });

describe('AchievementsPanel', () => {
  afterEach(cleanup);

  test('counts every tier and lists the achievements under their category', () => {
    const dialog = renderPanel();

    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Achievements 3/8' })).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['Milestones', 'Feats', 'Variety', 'Secret']);
    expect(within(groupNamed('Variety')).getByText('Explorer')).toBeTruthy();
  });

  test("shows each achievement's rarity and bonus XP", () => {
    renderPanel();
    const explorer = within(groupNamed('Variety')).getByRole('listitem');

    expect(within(explorer).getByText('Rare')).toBeTruthy();
    expect(within(explorer).getByText('+50 XP')).toBeTruthy();
  });

  test('shows progress toward a target, and today only for daily ones', () => {
    renderPanel();

    const explorer = screen.getByRole('progressbar', { name: 'Explorer progress' });
    expect(explorer.getAttribute('value')).toBe('3');
    expect(explorer.getAttribute('max')).toBe('10');
    expect(screen.getByText('3/10')).toBeTruthy();
    expect(screen.getByText('4/10 today')).toBeTruthy();
  });

  test('shows the tiers of a series in one row with progress toward the next tier', () => {
    renderPanel();
    const milestones = groupNamed('Milestones');

    expect(within(milestones).getAllByText(/^Centurion/)).toHaveLength(1);
    const tiers = within(milestones).getByRole('list', { name: 'Centurion tiers' });
    expect(
      within(tiers)
        .getAllByRole('listitem')
        .map((tier) => tier.textContent),
    ).toEqual([
      '✓ Bronze (unlocked)Common+25 XP',
      'Silver (locked)Rare+50 XP',
      'Gold (locked)Legendary+200 XP',
    ]);
    expect(within(milestones).getByText('Complete 50 review actions.')).toBeTruthy();
    expect(within(milestones).getByText('12/50 toward Silver')).toBeTruthy();
    expect(
      within(milestones)
        .getByRole('progressbar', { name: 'Centurion progress' })
        .getAttribute('max'),
    ).toBe('50');
    expect(within(milestones).getByText(/^Bronze unlocked/)).toBeTruthy();
  });

  test('a series with every tier unlocked shows no progress bar', () => {
    renderPanel([
      centurion('bronze', 10, 'common', 25, UNLOCKED_AT),
      centurion('silver', 50, 'rare', 50, UNLOCKED_AT),
      centurion('gold', 100, 'legendary', 200, UNLOCKED_AT),
    ]);

    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText(/^Gold unlocked/)).toBeTruthy();
  });

  test('a locked hidden achievement shows ??? and its hint, never its name', () => {
    renderPanel([
      { ...SPEEDRUNNER, name: 'Speedrunner', icon: '⏱️', description: 'Approve within 5 minutes.' },
    ]);
    const secret = groupNamed('Secret');

    expect(within(secret).getByText('???')).toBeTruthy();
    expect(within(secret).getByText('Some quests reward a very fast hand.')).toBeTruthy();
    expect(within(secret).queryByText('Speedrunner')).toBeNull();
    expect(within(secret).queryByText('Approve within 5 minutes.')).toBeNull();
    expect(within(secret).queryByText('⏱️')).toBeNull();
    expect(within(secret).getByText('Epic')).toBeTruthy();
  });

  test('an unlocked hidden achievement shows in full', () => {
    renderPanel();
    const secret = groupNamed('Secret');

    expect(within(secret).getByText('Archaeologist')).toBeTruthy();
    expect(
      within(secret).getByText(
        'Complete a review action on the quest that has waited longest on your board.',
      ),
    ).toBeTruthy();
  });

  test('achievements from a server without categories still show, under More', () => {
    renderPanel([
      {
        id: 'on-fire',
        name: 'On Fire',
        description: 'Review something five days in a row.',
        icon: '🔥',
        xpReward: 75,
      },
    ]);

    expect(screen.getByRole('heading', { name: 'More' })).toBeTruthy();
    expect(screen.getByText('+75 XP')).toBeTruthy();
  });
});
