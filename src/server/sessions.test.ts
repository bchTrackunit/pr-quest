import { describe, expect, test, vi } from 'vitest';

import type { GitHubViewer } from './github.ts';
import { GitHubApiError, NotSignedInError } from './githubApi.ts';
import type { ResolvedToken } from './githubToken.ts';
import { SessionManager, type SessionFactory } from './sessions.ts';

function setup(initial: { token?: ResolvedToken; viewers?: Record<string, GitHubViewer> } = {}) {
  let token = initial.token;
  let nowMs = 0;
  const viewers = initial.viewers ?? { gho_a: { login: 'Alice', avatarUrl: 'https://a' } };
  const fetchViewer = vi.fn(async (forToken: string) => {
    const viewer = viewers[forToken];
    if (!viewer) {
      throw new GitHubApiError('Bad credentials', { httpStatus: 401 });
    }
    return viewer;
  });
  const stops: Array<string> = [];
  const create = vi.fn<SessionFactory>(async ({ login }) => ({
    login,
    stop: () => stops.push(login),
  }));
  const sessions = new SessionManager({
    tokens: { resolve: async () => token, invalidate: vi.fn() },
    fetchViewer,
    create,
    log: () => undefined,
    now: () => nowMs,
  });
  return {
    sessions,
    fetchViewer,
    create,
    stops,
    setToken: (next: ResolvedToken | undefined) => {
      token = next;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('SessionManager', () => {
  test("opens the token owner's session with their lower-cased login", async () => {
    const { sessions, create } = setup({ token: { token: 'gho_a', source: 'gh' } });

    const session = await sessions.current();

    expect(session?.services).toEqual({ login: 'alice', stop: expect.any(Function) });
    expect(session?.account).toEqual({
      login: 'Alice',
      avatarUrl: 'https://a',
      tokenSource: 'gh',
    });
    expect(create).toHaveBeenCalledWith({ login: 'alice' });
  });

  test('reuses the session and the identity for the same token', async () => {
    const { sessions, create, fetchViewer } = setup({ token: { token: 'gho_a', source: 'gh' } });

    await Promise.all([sessions.current(), sessions.current()]);
    await sessions.current();

    expect(create).toHaveBeenCalledTimes(1);
    expect(fetchViewer).toHaveBeenCalledTimes(1);
  });

  test('has no session and require() throws NotSignedInError without a token', async () => {
    const { sessions } = setup();

    await expect(sessions.current()).resolves.toBeUndefined();
    await expect(sessions.require()).rejects.toBeInstanceOf(NotSignedInError);
  });

  test('keeps the session when the same user signs in with OAuth', async () => {
    const { sessions, setToken, create, stops } = setup({
      token: { token: 'gho_a', source: 'gh' },
      viewers: { gho_a: { login: 'Alice' }, gho_oauth: { login: 'alice' } },
    });
    await sessions.current();

    setToken({ token: 'gho_oauth', source: 'oauth' });
    sessions.reset();
    const session = await sessions.current();

    expect(create).toHaveBeenCalledTimes(1);
    expect(stops).toEqual([]);
    expect(session?.account.tokenSource).toBe('oauth');
  });

  test("stops the previous user's session when another user signs in", async () => {
    const { sessions, setToken, stops } = setup({
      token: { token: 'gho_a', source: 'gh' },
      viewers: { gho_a: { login: 'alice' }, gho_b: { login: 'bob' } },
    });
    await sessions.current();

    setToken({ token: 'gho_b', source: 'oauth' });
    sessions.reset();
    const session = await sessions.current();

    expect(stops).toEqual(['alice']);
    expect(session?.services.login).toBe('bob');
  });

  test('stops the session when the token goes away', async () => {
    const { sessions, setToken, stops } = setup({ token: { token: 'gho_a', source: 'gh' } });
    await sessions.current();

    setToken(undefined);
    sessions.reset();

    await expect(sessions.current()).resolves.toBeUndefined();
    expect(stops).toEqual(['alice']);
  });

  test('remembers a failed identity lookup for 30 seconds, then retries', async () => {
    const { sessions, fetchViewer, advance } = setup({ token: { token: 'gho_bad', source: 'gh' } });

    await expect(sessions.current()).rejects.toThrow('Bad credentials');
    await expect(sessions.current()).rejects.toThrow('Bad credentials');
    expect(fetchViewer).toHaveBeenCalledTimes(1);

    advance(30_001);
    await expect(sessions.current()).rejects.toThrow('Bad credentials');
    expect(fetchViewer).toHaveBeenCalledTimes(2);
  });

  test('close stops the open session, as on shutdown', async () => {
    const { sessions, stops } = setup({ token: { token: 'gho_a', source: 'gh' } });
    await sessions.current();

    sessions.close();
    await Promise.resolve();

    expect(stops).toEqual(['alice']);
    expect(sessions.peek()).toBeUndefined();
  });

  test('peek returns the open session without any lookups', async () => {
    const { sessions } = setup({ token: { token: 'gho_a', source: 'gh' } });

    expect(sessions.peek()).toBeUndefined();
    await sessions.current();

    expect(sessions.peek()?.services.login).toBe('alice');
  });
});
