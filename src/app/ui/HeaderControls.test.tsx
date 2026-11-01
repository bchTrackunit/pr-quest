// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { HeaderControls } from './HeaderControls.tsx';

describe('HeaderControls', () => {
  afterEach(cleanup);

  test('holds only the live status and the account, with the account last', () => {
    render(<HeaderControls account={<button type="button">@octocat</button>} connection="open" />);
    const group = screen.getByRole('group', { name: 'Status and account' });

    expect(within(group).getByRole('status').textContent).toContain('Live');
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['@octocat']);
    expect(group.lastElementChild?.textContent).toBe('@octocat');
  });

  test('says when live updates are paused', () => {
    render(<HeaderControls connection="reconnecting" />);
    expect(screen.getByRole('status').textContent).toContain('Reconnecting…');
  });
});
