// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { AuthStatusResponse, DeviceFlowStatus, GitHubAccount } from '../../../shared/api.ts';
import { ApiRequestError } from '../../../platform/ui/apiClient.ts';
import * as apiClient from '../../../platform/ui/apiClient.ts';
import { GitHubAccountControl } from './GitHubAccountControl.tsx';
import { DEVICE_POLL_MS, useGitHubAccount } from './useGitHubAccount.ts';

vi.mock('../../../platform/ui/apiClient.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/ui/apiClient.ts')>();
  return {
    ...actual,
    fetchAuthStatus: vi.fn(),
    startDeviceFlow: vi.fn(),
    fetchDeviceFlow: vi.fn(),
    cancelDeviceFlow: vi.fn(),
    signOut: vi.fn(),
  };
});

const api = vi.mocked(apiClient);

const OCTOCAT: GitHubAccount = {
  login: 'octocat',
  name: 'The Octocat',
  avatarUrl: 'https://avatars.githubusercontent.com/u/583231',
  tokenSource: 'oauth',
};

function authStatus(overrides: Partial<AuthStatusResponse> = {}): AuthStatusResponse {
  return { clientIdConfigured: true, device: { state: 'idle' }, ...overrides };
}

function pendingDevice(overrides: Partial<DeviceFlowStatus> = {}): DeviceFlowStatus {
  return {
    state: 'pending',
    userCode: 'WDJB-MJHT',
    verificationUri: 'https://github.com/login/device',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    ...overrides,
  };
}

const Harness = ({ onAccountChanged }: { onAccountChanged: () => void }) => {
  const { state, actions } = useGitHubAccount(onAccountChanged);
  return <GitHubAccountControl actions={actions} state={state} />;
};

function renderControl() {
  const onAccountChanged = vi.fn();
  render(<Harness onAccountChanged={onAccountChanged} />);
  return { onAccountChanged };
}

async function poll(): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(DEVICE_POLL_MS));
}

describe('GitHubAccountControl', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.fetchAuthStatus.mockResolvedValue(authStatus());
    api.startDeviceFlow.mockResolvedValue({ device: pendingDevice() });
    api.fetchDeviceFlow.mockResolvedValue({ device: pendingDevice() });
    api.cancelDeviceFlow.mockResolvedValue({ device: { state: 'idle' } });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const setupUser = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

  test('signs in through the device flow: code, copy, GitHub link, polling, then the account', async () => {
    const user = setupUser();
    const { onAccountChanged } = renderControl();

    await user.click(await screen.findByRole('button', { name: /Sign in with GitHub/ }));
    expect(api.startDeviceFlow).toHaveBeenCalledTimes(1);

    const dialog = screen.getByRole('dialog', { name: 'Sign in with GitHub' });
    const code = await within(dialog).findByLabelText('Sign-in code WDJB-MJHT');
    expect(code.textContent).toBe('WDJB-MJHT');
    const link = within(dialog).getByRole('link', { name: /Open github.com\/login\/device/ });
    expect(link.getAttribute('href')).toBe('https://github.com/login/device');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(within(dialog).getByText(/Code expires in/)).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: /Copy code/ }));
    expect(await navigator.clipboard.readText()).toBe('WDJB-MJHT');
    expect(within(dialog).getByText('Code copied.')).toBeTruthy();

    await poll();
    expect(api.fetchDeviceFlow).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByText('Waiting for you to enter the code on GitHub…')).toBeTruthy();

    api.fetchDeviceFlow.mockResolvedValue({ device: { state: 'complete' } });
    api.fetchAuthStatus.mockResolvedValue(
      authStatus({ account: OCTOCAT, device: { state: 'complete' } }),
    );
    await poll();

    expect(await within(dialog).findByText('Signed in as @octocat.')).toBeTruthy();
    expect(onAccountChanged).toHaveBeenCalledTimes(1);

    await poll();
    expect(api.fetchDeviceFlow).toHaveBeenCalledTimes(2);

    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/@octocat/)).toBeTruthy();
    expect(screen.getByText('OAuth')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  test('focuses Done when sign-in completes, and returns focus to the account on close', async () => {
    const user = setupUser();
    renderControl();
    await user.click(await screen.findByRole('button', { name: /Sign in with GitHub/ }));
    const dialog = screen.getByRole('dialog', { name: 'Sign in with GitHub' });
    within(dialog)
      .getByRole('button', { name: /Copy code/ })
      .focus();

    api.fetchDeviceFlow.mockResolvedValue({ device: { state: 'complete' } });
    api.fetchAuthStatus.mockResolvedValue(
      authStatus({ account: OCTOCAT, device: { state: 'complete' } }),
    );
    await poll();

    const done = await within(dialog).findByRole('button', { name: 'Done' });
    expect(document.activeElement).toBe(done);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sign out' }));
  });

  test('Escape still closes the dialog after Cancel and Try again replace the focused button', async () => {
    const user = setupUser();
    renderControl();
    await user.click(await screen.findByRole('button', { name: /Sign in with GitHub/ }));
    const dialog = screen.getByRole('dialog', { name: 'Sign in with GitHub' });
    await within(dialog).findByLabelText('Sign-in code WDJB-MJHT');

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await within(dialog).findByRole('button', { name: 'Sign in with GitHub' });
    expect(dialog.contains(document.activeElement)).toBe(true);

    api.fetchDeviceFlow.mockResolvedValue({ device: { state: 'expired' } });
    await user.click(within(dialog).getByRole('button', { name: 'Sign in with GitHub' }));
    await within(dialog).findByLabelText('Sign-in code WDJB-MJHT');
    await poll();
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await within(dialog).findByLabelText('Sign-in code WDJB-MJHT');
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('unmounting while a code is pending stops polling', async () => {
    const user = setupUser();
    renderControl();
    await user.click(await screen.findByRole('button', { name: /Sign in with GitHub/ }));
    await screen.findByLabelText('Sign-in code WDJB-MJHT');

    cleanup();
    await poll();
    await poll();

    expect(api.fetchDeviceFlow).not.toHaveBeenCalled();
  });

  test.each([
    ['expired', 'The code expired before it was entered.'],
    ['denied', 'Sign-in was denied on GitHub.'],
  ] as const)('a %s flow says so and offers a retry', async (state, message) => {
    const user = setupUser();
    renderControl();
    await user.click(await screen.findByRole('button', { name: /Sign in with GitHub/ }));
    const dialog = screen.getByRole('dialog', { name: 'Sign in with GitHub' });
    await within(dialog).findByLabelText('Sign-in code WDJB-MJHT');

    api.fetchDeviceFlow.mockResolvedValue({ device: { state } });
    await poll();

    expect(within(dialog).getByText(message)).toBeTruthy();
    expect(within(dialog).queryByLabelText(/Sign-in code/)).toBeNull();
    await poll();
    expect(api.fetchDeviceFlow).toHaveBeenCalledTimes(1);

    api.startDeviceFlow.mockResolvedValue({ device: pendingDevice({ userCode: 'NEW1-CODE' }) });
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(api.startDeviceFlow).toHaveBeenCalledTimes(2);
    expect(await within(dialog).findByLabelText('Sign-in code NEW1-CODE')).toBeTruthy();
  });

  test('shows a failed flow with its error and a retry', async () => {
    const user = setupUser();
    renderControl();
    await user.click(await screen.findByRole('button', { name: /Sign in with GitHub/ }));
    const dialog = screen.getByRole('dialog', { name: 'Sign in with GitHub' });
    await within(dialog).findByLabelText('Sign-in code WDJB-MJHT');

    api.fetchDeviceFlow.mockResolvedValue({
      device: { state: 'error', error: 'Signed in, but the token did not work' },
    });
    await poll();

    expect(
      within(dialog).getByText('Sign-in failed: Signed in, but the token did not work'),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  test('marks the code expired locally once expiresAt passes', async () => {
    const user = setupUser();
    api.startDeviceFlow.mockResolvedValue({
      device: pendingDevice({ expiresAt: new Date(Date.now() + 1000).toISOString() }),
    });
    renderControl();
    await user.click(await screen.findByRole('button', { name: /Sign in with GitHub/ }));
    const dialog = screen.getByRole('dialog', { name: 'Sign in with GitHub' });
    await within(dialog).findByLabelText('Sign-in code WDJB-MJHT');

    await poll();

    expect(api.fetchDeviceFlow).not.toHaveBeenCalled();
    expect(within(dialog).getByText('The code expired before it was entered.')).toBeTruthy();
  });

  test('cancelling stops the flow on the server', async () => {
    const user = setupUser();
    renderControl();
    await user.click(await screen.findByRole('button', { name: /Sign in with GitHub/ }));
    const dialog = screen.getByRole('dialog', { name: 'Sign in with GitHub' });
    await within(dialog).findByLabelText('Sign-in code WDJB-MJHT');

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(api.cancelDeviceFlow).toHaveBeenCalledTimes(1);
    expect(await within(dialog).findByRole('button', { name: 'Sign in with GitHub' })).toBeTruthy();
    await poll();
    expect(api.fetchDeviceFlow).not.toHaveBeenCalled();
  });

  test('keeps polling after the dialog closes and offers to finish signing in', async () => {
    const user = setupUser();
    renderControl();
    await user.click(await screen.findByRole('button', { name: /Sign in with GitHub/ }));
    await screen.findByLabelText('Sign-in code WDJB-MJHT');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await poll();
    expect(api.fetchDeviceFlow).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /Finish signing in/ }));
    expect(api.startDeviceFlow).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Sign-in code WDJB-MJHT')).toBeTruthy();
  });

  test('resumes a flow that was already pending when the page loaded', async () => {
    api.fetchAuthStatus.mockResolvedValue(authStatus({ device: pendingDevice() }));
    renderControl();

    expect(await screen.findByRole('button', { name: /Finish signing in/ })).toBeTruthy();
    await poll();
    expect(api.fetchDeviceFlow).toHaveBeenCalledTimes(1);
  });

  test('without a client ID the button explains how to configure sign-in', async () => {
    const user = setupUser();
    api.fetchAuthStatus.mockResolvedValue(authStatus({ clientIdConfigured: false }));
    renderControl();

    const button = await screen.findByRole('button', { name: /Sign in with GitHub/ });
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
    await user.click(button);

    expect(api.startDeviceFlow).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Sign in with GitHub' });
    expect(within(dialog).getByText('PR_QUEST_GITHUB_CLIENT_ID')).toBeTruthy();
    const readme = within(dialog).getByRole('link', { name: /How to set up sign-in/ });
    expect(readme.getAttribute('href')).toContain('#sign-in-with-github');
  });

  test('switches to the setup steps when the server reports missingConfig on start', async () => {
    const user = setupUser();
    api.startDeviceFlow.mockRejectedValue(
      new ApiRequestError(409, 'missingConfig', 'Set PR_QUEST_GITHUB_CLIENT_ID'),
    );
    renderControl();

    await user.click(await screen.findByRole('button', { name: /Sign in with GitHub/ }));

    const dialog = screen.getByRole('dialog', { name: 'Sign in with GitHub' });
    expect(await within(dialog).findByText('PR_QUEST_GITHUB_CLIENT_ID')).toBeTruthy();
  });

  test('shows the gh CLI fallback without a sign-out button', async () => {
    api.fetchAuthStatus.mockResolvedValue(
      authStatus({ account: { login: 'octocat', tokenSource: 'gh' } }),
    );
    renderControl();

    expect(await screen.findByText('gh CLI')).toBeTruthy();
    expect(screen.getByText(/@octocat/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  test('signing out forgets the OAuth account and tells the game to reload', async () => {
    const user = setupUser();
    api.fetchAuthStatus.mockResolvedValue(authStatus({ account: OCTOCAT }));
    api.signOut.mockResolvedValue(authStatus());
    const { onAccountChanged } = renderControl();

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(api.signOut).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: /Sign in with GitHub/ })).toBeTruthy();
    expect(onAccountChanged).toHaveBeenCalledTimes(1);
  });

  test('says so when signing out falls back to a different gh CLI account', async () => {
    const user = setupUser();
    api.fetchAuthStatus.mockResolvedValue(authStatus({ account: OCTOCAT }));
    const reply = {
      ...authStatus({ account: { login: 'hubot', tokenSource: 'gh' } }),
      fellBackFrom: 'octocat',
    };
    api.signOut.mockResolvedValue(reply);
    api.fetchAuthStatus.mockResolvedValue(authStatus({ account: { ...OCTOCAT, login: 'mona' } }));
    renderControl();

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    const notice = await screen.findByText(/now acts as @hubot/);
    expect(notice.textContent).toBe(
      'Signed out of @octocat. PR Quest now acts as @hubot through your GitHub CLI login. Run gh auth switch or gh auth logout to change that.',
    );
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/now acts as @hubot/)).toBeNull();
  });

  test('spots the gh fallback even when the server does not report it', async () => {
    const user = setupUser();
    api.fetchAuthStatus.mockResolvedValue(authStatus({ account: OCTOCAT }));
    api.signOut.mockResolvedValue(authStatus({ account: { login: 'hubot', tokenSource: 'gh' } }));
    renderControl();

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(
      await screen.findByText(/Signed out of @octocat\. PR Quest now acts as @hubot/),
    ).toBeTruthy();
  });

  test('says nothing when the gh CLI account is the one that signed out', async () => {
    const user = setupUser();
    api.fetchAuthStatus.mockResolvedValue(authStatus({ account: OCTOCAT }));
    api.signOut.mockResolvedValue(authStatus({ account: { login: 'Octocat', tokenSource: 'gh' } }));
    renderControl();

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('gh CLI')).toBeTruthy();
    expect(screen.queryByText(/now acts as/)).toBeNull();
  });

  test('hides itself when the server has no auth routes yet', async () => {
    api.fetchAuthStatus.mockRejectedValue(
      new ApiRequestError(501, 'notImplemented', 'Not implemented'),
    );
    const { container } = render(<Harness onAccountChanged={vi.fn()} />);

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(container.textContent).toBe('');
  });
});
