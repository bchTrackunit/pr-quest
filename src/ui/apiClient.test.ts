import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ApiRequestError,
  approveQuest,
  cancelDeviceFlow,
  describeError,
  discardRun,
  fetchAuthStatus,
  fetchDeviceFlow,
  fetchHealth,
  fetchModels,
  fetchSettings,
  postRun,
  removeApiKey,
  setApiKey,
  signOut,
  startDeviceFlow,
  startReview,
  updateSettings,
} from './apiClient.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

const lastInit = (): RequestInit | undefined => fetchMock.mock.calls.at(-1)?.[1];

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>(async () => Response.json({ run: { id: 'run-1' } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiRequest', () => {
  test.each([
    ['discardRun without a body', () => discardRun('run-1'), '{}'],
    ['postRun with the default body', () => postRun('run-1'), '{}'],
    ['startReview with a model', () => startReview('o/r#1', { model: 'm' }), '{"model":"m"}'],
  ])('sends %s as JSON', async (_label, call, body) => {
    await call();

    expect(lastInit()).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  });

  test('sends GETs without a body or content type', async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true }));

    await fetchHealth();

    expect(lastInit()).toMatchObject({ method: 'GET' });
    expect(lastInit()?.body).toBeUndefined();
    expect(lastInit()?.headers).toBeUndefined();
  });

  test('rejects with the server error code', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: { code: 'conflict', message: 'Busy' } }, { status: 409 }),
    );

    await expect(discardRun('run-1')).rejects.toEqual(new ApiRequestError(409, 'conflict', 'Busy'));
  });
});

describe('auth and settings routes', () => {
  const lastUrl = (): string => String(fetchMock.mock.calls.at(-1)?.[0]);

  test.each([
    ['startDeviceFlow', () => startDeviceFlow(), 'POST', '/api/auth/device', '{}'],
    ['cancelDeviceFlow', () => cancelDeviceFlow(), 'DELETE', '/api/auth/device', '{}'],
    ['signOut', () => signOut(), 'POST', '/api/auth/sign-out', '{}'],
    [
      'updateSettings',
      () => updateSettings({ reviewProvider: 'claude', models: { claude: null } }),
      'PUT',
      '/api/settings',
      '{"reviewProvider":"claude","models":{"claude":null}}',
    ],
    [
      'setApiKey',
      () => setApiKey('anthropic', 'sk-ant-123'),
      'PUT',
      '/api/settings/keys/anthropic',
      '{"value":"sk-ant-123"}',
    ],
    ['removeApiKey', () => removeApiKey('linear'), 'DELETE', '/api/settings/keys/linear', '{}'],
  ])('%s sends JSON with the CSRF-safe content type', async (_label, call, method, url, body) => {
    await call();

    expect(lastUrl()).toBe(url);
    expect(lastInit()).toMatchObject({
      method,
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  });

  test.each([
    ['fetchAuthStatus', () => fetchAuthStatus(), '/api/auth/status'],
    ['fetchDeviceFlow', () => fetchDeviceFlow(), '/api/auth/device'],
    ['fetchSettings', () => fetchSettings(), '/api/settings'],
    ['fetchModels', () => fetchModels('claude'), '/api/settings/models?provider=claude'],
  ])('%s is a plain GET', async (_label, call, url) => {
    await call();

    expect(lastUrl()).toBe(url);
    expect(lastInit()).toMatchObject({ method: 'GET' });
    expect(lastInit()?.body).toBeUndefined();
    expect(lastInit()?.headers).toBeUndefined();
  });
});

describe('approveQuest', () => {
  test('confirms and names the head commit the player saw', async () => {
    await approveQuest('o/r#1', SHA, 'LGTM');

    expect(JSON.parse(String(lastInit()?.body))).toEqual({
      confirm: true,
      headSha: SHA,
      body: 'LGTM',
    });
  });

  test('leaves out an empty comment', async () => {
    await approveQuest('o/r#1', SHA);

    expect(JSON.parse(String(lastInit()?.body))).toEqual({ confirm: true, headSha: SHA });
  });
});

describe('describeError', () => {
  test('asks the player to re-check when new commits were pushed', () => {
    expect(describeError(new ApiRequestError(409, 'headChanged', 'server text'))).toBe(
      'New commits were pushed to this PR. Re-check them before approving.',
    );
  });
});
