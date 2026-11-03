// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { PreferencesMenu, type PreferencesMenuProps } from './PreferencesMenu.tsx';

function renderMenu(overrides: Partial<PreferencesMenuProps> = {}) {
  const props: PreferencesMenuProps = {
    notificationAccess: 'granted',
    notificationsEnabled: true,
    soundEnabled: true,
    onClickNotifications: vi.fn(),
    onClickSound: vi.fn(),
    onClickSettings: vi.fn(),
    ...overrides,
  };
  render(<PreferencesMenu {...props} />);
  return props;
}

const switchNamed = (name: string) => screen.getByRole('switch', { name });

describe('PreferencesMenu', () => {
  afterEach(cleanup);

  test('shows notifications and sound as labelled switches with their state, then Settings', () => {
    renderMenu({ soundEnabled: false });

    expect(switchNamed('Notifications').getAttribute('aria-checked')).toBe('true');
    expect(switchNamed('Sound').getAttribute('aria-checked')).toBe('false');
    expect(switchNamed('Notifications').textContent).toContain('On');
    expect(switchNamed('Sound').textContent).toContain('Off');
    expect(Array.from(document.querySelectorAll('button'))).toEqual([
      switchNamed('Notifications'),
      switchNamed('Sound'),
      screen.getByRole('button', { name: 'Settings' }),
    ]);
  });

  test('the switches and Settings call their handlers', async () => {
    const user = userEvent.setup();
    const props = renderMenu();

    await user.click(switchNamed('Notifications'));
    await user.click(switchNamed('Sound'));
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    expect(props.onClickNotifications).toHaveBeenCalledTimes(1);
    expect(props.onClickSound).toHaveBeenCalledTimes(1);
    expect(props.onClickSettings).toHaveBeenCalledTimes(1);
  });

  test('notifications start off and explain the permission prompt', () => {
    renderMenu({ notificationAccess: 'default', notificationsEnabled: false });

    const notifications = switchNamed('Notifications');
    expect(notifications.getAttribute('aria-checked')).toBe('false');
    expect(notifications.hasAttribute('disabled')).toBe(false);
    const hintId = notifications.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(hintId)?.textContent).toBe(
      'Your browser asks for permission first.',
    );
  });

  test.each([
    ['denied', 'Blocked. Allow notifications for this site in your browser settings.'],
    ['unsupported', 'This browser does not support notifications.'],
  ] as const)('a %s notification switch is off, disabled and says why', (access, hint) => {
    renderMenu({ notificationAccess: access });

    const notifications = switchNamed('Notifications');
    expect(notifications.getAttribute('aria-checked')).toBe('false');
    expect(notifications.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(hint).id).toBe(notifications.getAttribute('aria-describedby'));
  });
});
