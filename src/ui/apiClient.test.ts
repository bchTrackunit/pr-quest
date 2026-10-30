import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ApiRequestError,
  approveQuest,
  describeError,
  discardRun,
  fetchHealth,
  postRun,
  startReview,
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
