// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';

import { PlayerHud, type PlayerHudProps } from './PlayerHud.tsx';
import { makeAchievements, makePlayer } from '../../../platform/ui/test-utils/fixtures.ts';

function renderHud(overrides: Partial<PlayerHudProps> = {}) {
  const props: PlayerHudProps = {
    player: makePlayer(),
    achievements: makeAchievements(),
    ...overrides,
  };
  render(<PlayerHud {...props} />);
  return props;
}

describe('PlayerHud', () => {
  afterEach(cleanup);

  test('shows level, XP progress, streak and recent achievements', () => {
    renderHud();
    expect(screen.getByRole('img', { name: 'Level 3' })).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Experience toward level 4' });
    expect(bar.getAttribute('aria-valuenow')).toBe('150');
    expect(bar.getAttribute('aria-valuemax')).toBe('400');
    expect(screen.getByText(/2-day streak/)).toBeTruthy();
    const recent = screen.getByRole('list', { name: 'Recent achievements' });
    expect(within(recent).getByRole('img', { name: 'First Blood' })).toBeTruthy();
  });

  test('a recent badge shows its name in a tooltip on hover', async () => {
    const user = userEvent.setup();
    renderHud();

    await user.hover(screen.getByRole('img', { name: 'First Blood' }));
    expect(screen.getByRole('tooltip').textContent).toBe('First Blood');
  });

  test('holds only game info: the one control is the achievements button', () => {
    renderHud();
    const hud = screen.getByRole('region', { name: 'Player' });
    expect(
      within(hud)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['🏅 Achievements 1/3']);
  });

  test('handles a missing player gracefully', () => {
    renderHud({ player: undefined, playerError: 'The server does not support this yet.' });
    expect(screen.getByRole('img', { name: 'Level unknown' })).toBeTruthy();
    expect(screen.getByText(/Player stats unavailable/)).toBeTruthy();
  });

  test('opens the achievements panel with locked, secret and unlocked entries', async () => {
    const user = userEvent.setup();
    renderHud();
    await user.click(screen.getByRole('button', { name: /Achievements/ }));

    const dialog = screen.getByRole('dialog', { name: 'Achievements 1/3' });
    expect(within(dialog).getByText('First Blood')).toBeTruthy();
    expect(within(dialog).getByText('(unlocked)')).toBeTruthy();
    const progress = within(dialog).getByRole('progressbar', { name: 'Team Player progress' });
    expect(progress.getAttribute('value')).toBe('3');
    expect(within(dialog).getByText('???')).toBeTruthy();
    expect(within(dialog).queryByText('On Fire')).toBeNull();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
