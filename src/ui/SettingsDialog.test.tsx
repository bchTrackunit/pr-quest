// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ListModelsResponse, SettingsResponse } from '../shared/api.ts';
import { ApiRequestError } from './apiClient.ts';
import * as apiClient from './apiClient.ts';
import { SettingsDialog } from './SettingsDialog.tsx';
import type { SettingsTarget } from './settingsModel.ts';
import type { GitHubAccountController, GitHubAccountState } from './useGitHubAccount.ts';

vi.mock('./apiClient.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./apiClient.ts')>();
  return {
    ...actual,
    fetchSettings: vi.fn(),
    updateSettings: vi.fn(),
    setApiKey: vi.fn(),
    removeApiKey: vi.fn(),
    fetchModels: vi.fn(),
  };
});

const api = vi.mocked(apiClient);

function makeSettings(overrides: Partial<SettingsResponse> = {}): SettingsResponse {
  return {
    reviewProvider: 'cursor',
    models: {},
    keys: {
      cursor: { set: false },
      anthropic: { set: true, source: 'env', last4: 'Zx9Q' },
      linear: { set: true, source: 'settings', last4: 'abcd' },
    },
    ...overrides,
  };
}

function makeModels(overrides: Partial<ListModelsResponse> = {}): ListModelsResponse {
  return {
    provider: 'cursor',
    models: [
      { id: 'composer-2', displayName: 'Composer 2' },
      { id: 'gpt-5.6', displayName: 'GPT-5.6' },
    ],
    source: 'api',
    ...overrides,
  };
}

function makeGitHub(state: Partial<GitHubAccountState> = {}): GitHubAccountController {
  return {
    state: { load: 'ready', clientIdConfigured: true, device: { state: 'idle' }, ...state },
    actions: { startSignIn: vi.fn(), cancelSignIn: vi.fn(), signOut: vi.fn() },
  };
}

function renderDialog(
  target: SettingsTarget = { section: 'github' },
  github: GitHubAccountController = makeGitHub(),
) {
  const onClickClose = vi.fn();
  render(<SettingsDialog github={github} onClickClose={onClickClose} target={target} />);
  return { onClickClose, github };
}

const keyRow = (name: string): HTMLElement => screen.getByRole('listitem', { name });

describe('SettingsDialog', () => {
  beforeEach(() => {
    api.fetchSettings.mockResolvedValue(makeSettings());
    api.fetchModels.mockImplementation((provider) =>
      Promise.resolve(
        provider === 'claude'
          ? makeModels({
              provider: 'claude',
              models: [{ id: 'claude-opus-5', displayName: 'Claude Opus 5' }],
            })
          : makeModels(),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test('opens at the requested section and closes on Escape', async () => {
    const user = userEvent.setup();
    const { onClickClose } = renderDialog({ section: 'keys' });

    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: 'API keys' }));
    await screen.findByRole('listitem', { name: 'Cursor' });

    await user.keyboard('{Escape}');
    expect(onClickClose).toHaveBeenCalledTimes(1);
  });

  test('sets a key, announces it and clears the input', async () => {
    const user = userEvent.setup();
    api.setApiKey.mockResolvedValue(
      makeSettings({
        keys: { ...makeSettings().keys, cursor: { set: true, source: 'settings', last4: '7f3e' } },
      }),
    );
    renderDialog({ section: 'keys' });

    const row = await screen.findByRole('listitem', { name: 'Cursor' });
    expect(within(row).getByText('Not set')).toBeTruthy();
    const input = within(row).getByLabelText('Cursor key');
    expect(input.getAttribute('type')).toBe('password');
    await user.type(input, 'crsr_secret_7f3e');
    await user.click(within(row).getByRole('button', { name: 'Save key for Cursor' }));

    expect(api.setApiKey).toHaveBeenCalledWith('cursor', 'crsr_secret_7f3e');
    expect(await screen.findByText('Saved the Cursor key.')).toBeTruthy();
    const saved = keyRow('Cursor');
    expect(within(saved).getByText('••••7f3e')).toBeTruthy();
    expect(within(saved).getByText('settings')).toBeTruthy();
    expect(within(saved).getByLabelText<HTMLInputElement>('Replace the Cursor key').value).toBe('');
  });

  test('does not send an empty key', async () => {
    const user = userEvent.setup();
    renderDialog({ section: 'keys' });

    const row = await screen.findByRole('listitem', { name: 'Cursor' });
    await user.click(within(row).getByRole('button', { name: 'Save key for Cursor' }));

    expect(api.setApiKey).not.toHaveBeenCalled();
    expect(within(row).getByRole('alert').textContent).toBe('Enter the Cursor key first.');
  });

  test('replaces a saved key', async () => {
    const user = userEvent.setup();
    api.setApiKey.mockResolvedValue(
      makeSettings({
        keys: { ...makeSettings().keys, linear: { set: true, source: 'settings', last4: 'wxyz' } },
      }),
    );
    renderDialog({ section: 'keys' });

    const row = await screen.findByRole('listitem', { name: 'Linear' });
    expect(within(row).getByText('••••abcd')).toBeTruthy();
    await user.type(within(row).getByLabelText('Replace the Linear key'), 'lin_api_new_wxyz');
    await user.click(within(row).getByRole('button', { name: 'Replace key for Linear' }));

    expect(api.setApiKey).toHaveBeenCalledWith('linear', 'lin_api_new_wxyz');
    expect(await within(keyRow('Linear')).findByText('••••wxyz')).toBeTruthy();
  });

  test('keeps the typed key in the input when saving fails, and shows why', async () => {
    const user = userEvent.setup();
    api.setApiKey.mockRejectedValue(new ApiRequestError(400, 'badRequest', 'value: no spaces'));
    renderDialog({ section: 'keys' });

    const row = await screen.findByRole('listitem', { name: 'Cursor' });
    const input = within(row).getByLabelText<HTMLInputElement>('Cursor key');
    await user.type(input, 'bad key');
    await user.click(within(row).getByRole('button', { name: 'Save key for Cursor' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't save: value: no spaces",
    );
    expect(input.value).toBe('bad key');
  });

  test('removes a key only after confirming', async () => {
    const user = userEvent.setup();
    api.removeApiKey.mockResolvedValue(
      makeSettings({ keys: { ...makeSettings().keys, linear: { set: false } } }),
    );
    renderDialog({ section: 'keys' });

    const row = await screen.findByRole('listitem', { name: 'Linear' });
    await user.click(within(row).getByRole('button', { name: 'Remove the Linear key' }));
    const confirm = within(row).getByRole('group', { name: 'Remove the Linear key?' });
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Keep it' }));

    await user.click(within(confirm).getByRole('button', { name: 'Keep it' }));
    expect(api.removeApiKey).not.toHaveBeenCalled();

    await user.click(within(row).getByRole('button', { name: 'Remove the Linear key' }));
    await user.click(
      within(within(row).getByRole('group')).getByRole('button', { name: 'Remove the Linear key' }),
    );

    expect(api.removeApiKey).toHaveBeenCalledWith('linear');
    expect(await screen.findByText('Removed the Linear key.')).toBeTruthy();
    expect(within(keyRow('Linear')).getByText('Not set')).toBeTruthy();
  });

  test('keeps focus in the row when the remove confirmation goes away', async () => {
    const user = userEvent.setup();
    api.removeApiKey.mockResolvedValue(
      makeSettings({ keys: { ...makeSettings().keys, linear: { set: false } } }),
    );
    renderDialog({ section: 'keys' });

    const row = await screen.findByRole('listitem', { name: 'Linear' });
    await user.click(within(row).getByRole('button', { name: 'Remove the Linear key' }));
    await user.click(within(row).getByRole('button', { name: 'Keep it' }));
    expect(document.activeElement).toBe(
      within(row).getByRole('button', { name: 'Remove the Linear key' }),
    );

    await user.click(within(row).getByRole('button', { name: 'Remove the Linear key' }));
    await user.click(
      within(within(row).getByRole('group')).getByRole('button', { name: 'Remove the Linear key' }),
    );
    await screen.findByText('Removed the Linear key.');
    expect(document.activeElement).toBe(within(keyRow('Linear')).getByLabelText('Linear key'));
  });

  test('keeps focus on the key input after saving with the button', async () => {
    const user = userEvent.setup();
    api.setApiKey.mockResolvedValue(
      makeSettings({
        keys: { ...makeSettings().keys, cursor: { set: true, source: 'settings', last4: '7f3e' } },
      }),
    );
    renderDialog({ section: 'keys' });

    const row = await screen.findByRole('listitem', { name: 'Cursor' });
    await user.type(within(row).getByLabelText('Cursor key'), 'crsr_secret_7f3e');
    await user.click(within(row).getByRole('button', { name: 'Save key for Cursor' }));

    await screen.findByText('Saved the Cursor key.');
    expect(document.activeElement).toBe(
      within(keyRow('Cursor')).getByLabelText('Replace the Cursor key'),
    );
  });

  test("reloads the provider's models after its key changes", async () => {
    const user = userEvent.setup();
    api.setApiKey.mockResolvedValue(
      makeSettings({
        keys: { ...makeSettings().keys, cursor: { set: true, source: 'settings', last4: '7f3e' } },
      }),
    );
    renderDialog({ section: 'keys' });

    await screen.findByRole('combobox', { name: 'Cursor model' });
    expect(api.fetchModels).toHaveBeenCalledTimes(1);
    const row = keyRow('Cursor');
    await user.type(within(row).getByLabelText('Cursor key'), 'crsr_secret_7f3e');
    await user.click(within(row).getByRole('button', { name: 'Save key for Cursor' }));

    await screen.findByText('Saved the Cursor key.');
    await screen.findByRole('combobox', { name: 'Cursor model' });
    expect(api.fetchModels).toHaveBeenCalledTimes(2);
  });

  test('shows env keys as read-only with a hint to edit .env.local', async () => {
    renderDialog({ section: 'keys' });

    const row = await screen.findByRole('listitem', { name: 'Claude (Anthropic)' });
    expect(within(row).getByText('••••Zx9Q')).toBeTruthy();
    expect(within(row).getByText('env')).toBeTruthy();
    expect(within(row).getByText('ANTHROPIC_API_KEY')).toBeTruthy();
    expect(within(row).getAllByText('.env.local').length).toBeGreaterThan(0);
    expect(within(row).queryByRole('textbox')).toBeNull();
    expect(row.querySelector('input')).toBeNull();
    expect(within(row).queryByRole('button')).toBeNull();
  });

  test('switches the provider, loads its models and saves a model choice', async () => {
    const user = userEvent.setup();
    api.updateSettings
      .mockResolvedValueOnce(makeSettings({ reviewProvider: 'claude' }))
      .mockResolvedValueOnce(
        makeSettings({ reviewProvider: 'claude', models: { claude: 'claude-opus-5' } }),
      );
    renderDialog({ section: 'provider' });

    const cursorModel = await screen.findByRole('combobox', { name: 'Cursor model' });
    expect(within(cursorModel).getByRole('option', { name: 'GPT-5.6' })).toBeTruthy();
    expect(api.fetchModels).toHaveBeenCalledWith('cursor', expect.any(AbortSignal));
    expect(screen.queryByText(/has no API key/)).toBeTruthy();

    await user.click(screen.getByRole('radio', { name: 'Claude' }));
    expect(api.updateSettings).toHaveBeenCalledWith({ reviewProvider: 'claude' });
    expect(await screen.findByText('Claude reviews your quests now.')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Claude' })).toHaveProperty('checked', true);
    expect(screen.queryByText(/has no API key/)).toBeNull();

    const claudeModel = await screen.findByRole('combobox', { name: 'Claude model' });
    expect(api.fetchModels).toHaveBeenCalledWith('claude', expect.any(AbortSignal));
    await user.selectOptions(claudeModel, 'claude-opus-5');

    expect(api.updateSettings).toHaveBeenLastCalledWith({ models: { claude: 'claude-opus-5' } });
    expect(await screen.findByText('Claude reviews use claude-opus-5.')).toBeTruthy();
  });

  test('going back to the default model sends null', async () => {
    const user = userEvent.setup();
    api.fetchSettings.mockResolvedValue(makeSettings({ models: { cursor: 'gpt-5.6' } }));
    api.updateSettings.mockResolvedValue(makeSettings());
    renderDialog({ section: 'provider' });

    const select = await screen.findByRole('combobox', { name: 'Cursor model' });
    expect(select).toHaveProperty('value', 'gpt-5.6');
    await user.selectOptions(select, '');

    expect(api.updateSettings).toHaveBeenCalledWith({ models: { cursor: null } });
    expect(await screen.findByText('Cursor reviews use the default model.')).toBeTruthy();
  });

  test('reverts the provider and shows the error when saving fails', async () => {
    const user = userEvent.setup();
    api.updateSettings.mockRejectedValue(new ApiRequestError(500, 'internal', 'Disk full'));
    renderDialog({ section: 'provider' });

    await screen.findByRole('combobox', { name: 'Cursor model' });
    await user.click(screen.getByRole('radio', { name: 'Claude' }));

    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't save: Disk full");
    expect(screen.getByRole('radio', { name: 'Cursor' })).toHaveProperty('checked', true);
  });

  test('shows a loading state while the models load, then a fallback-list note', async () => {
    let resolve: (value: ListModelsResponse) => void = () => undefined;
    api.fetchModels.mockReturnValue(
      new Promise((resolver) => {
        resolve = resolver;
      }),
    );
    renderDialog({ section: 'provider' });

    expect(await screen.findByText('Loading Cursor models…')).toBeTruthy();
    resolve(makeModels({ source: 'fallback', error: 'no key' }));

    expect(await screen.findByText(/Fallback list/)).toBeTruthy();
    expect(screen.getByText(/\(no key\)/)).toBeTruthy();
  });

  test('falls back to a free-text model when the models endpoint is not implemented', async () => {
    const user = userEvent.setup();
    api.fetchModels.mockRejectedValue(new ApiRequestError(501, 'notImplemented', 'nope'));
    api.updateSettings.mockResolvedValue(makeSettings({ models: { cursor: 'composer-3' } }));
    renderDialog({ section: 'provider' });

    const input = await screen.findByRole('textbox', { name: 'Cursor model' });
    expect(screen.getByText(/can't list models yet/)).toBeTruthy();
    await user.type(input, ' composer-3 ');
    await user.click(screen.getByRole('button', { name: 'Save model' }));

    expect(api.updateSettings).toHaveBeenCalledWith({ models: { cursor: 'composer-3' } });
    expect(await screen.findByText('Cursor reviews use composer-3.')).toBeTruthy();
  });

  test('the no-key hint jumps to the key input', async () => {
    const user = userEvent.setup();
    renderDialog({ section: 'provider' });

    await user.click(await screen.findByRole('button', { name: 'Add the Cursor key' }));

    expect(document.activeElement).toBe(screen.getByLabelText('Cursor key'));
  });

  test('highlights the key a review needs', async () => {
    renderDialog({ section: 'keys', key: 'cursor' });

    const row = await screen.findByRole('listitem', { name: 'Cursor' });
    expect(within(row).getByText(/Needed for Cursor reviews/)).toBeTruthy();
    expect(row.className).toContain('key-row--highlight');
    expect(document.activeElement).toBe(within(row).getByLabelText('Cursor key'));
  });

  test('says so when the server has no settings routes yet', async () => {
    api.fetchSettings.mockRejectedValue(new ApiRequestError(501, 'notImplemented', 'nope'));
    renderDialog();

    expect(await screen.findAllByText("This server doesn't support settings yet.")).toHaveLength(2);
  });

  test('shows the signed-in account with its token source and signs out', async () => {
    const user = userEvent.setup();
    const { github } = renderDialog(
      { section: 'github' },
      makeGitHub({ account: { login: 'octocat', name: 'Mona', tokenSource: 'oauth' } }),
    );

    const section = screen.getByRole('region', { name: 'GitHub account' });
    expect(within(section).getByText('@octocat')).toBeTruthy();
    expect(within(section).getByText('Signed in with GitHub (OAuth)')).toBeTruthy();
    expect(within(section).getByText('OAuth')).toBeTruthy();
    expect(within(section).queryByRole('button', { name: 'Sign in with GitHub' })).toBeNull();

    await user.click(within(section).getByRole('button', { name: 'Sign out' }));
    expect(github.actions.signOut).toHaveBeenCalledTimes(1);
  });

  test('offers sign-in on top of the gh CLI fallback', async () => {
    const user = userEvent.setup();
    const { github } = renderDialog(
      { section: 'github' },
      makeGitHub({ account: { login: 'octocat', tokenSource: 'gh' } }),
    );

    const section = screen.getByRole('region', { name: 'GitHub account' });
    expect(within(section).getByText('gh CLI')).toBeTruthy();
    expect(within(section).queryByRole('button', { name: 'Sign out' })).toBeNull();
    await user.click(within(section).getByRole('button', { name: 'Sign in with GitHub' }));
    expect(github.actions.startSignIn).toHaveBeenCalledTimes(1);
  });
});
