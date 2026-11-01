import { describe, expect, test, vi } from 'vitest';

import type { GitHubViewer } from '../../features/quests/server/github.ts';
import {
  GitHubApiError,
  GitHubNetworkError,
  NotSignedInError,
} from '../../platform/server/githubApi.ts';
import type { ResolvedToken } from '../../features/auth/server/githubToken.ts';
import {
  SessionEndedError,
  SessionManager,
  type SessionContext,
  type SessionFactory,
} from './sessions.ts';

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
  const contexts = new Map<string, SessionContext>();
  const create = vi.fn<SessionFactory>(async (context) => {
    contexts.set(context.login, context);
    return { login: context.login, stop: () => stops.push(context.login) };
  });
  const invalidate = vi.fn();
  const sessions = new SessionManager({
    tokens: { resolve: async () => token, invalidate },
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
    invalidate,
    contextOf: (login: string): SessionContext => {
      const context = contexts.get(login);
      if (!context) {
        throw new Error(`no session was opened for ${login}`);
      }
      return context;
    },
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
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ login: 'alice' }));
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

  test("keeps the session and moves it to the new token when the same user's token changes", async () => {
    const { sessions, setToken, create, stops, contextOf } = setup({
      token: { token: 'gho_a', source: 'gh' },
      viewers: { gho_a: { login: 'Alice' }, gho_oauth: { login: 'alice' } },
    });
    await sessions.current();

    setToken({ token: 'gho_oauth', source: 'oauth' });
    const session = await sessions.current();

    expect(create).toHaveBeenCalledTimes(1);
    expect(stops).toEqual([]);
    expect(session?.account.tokenSource).toBe('oauth');
    await expect(contextOf('alice').token()).resolves.toBe('gho_oauth');
  });

  test('reset closes the open session right away, even before the next lookup', async () => {
    const { sessions, setToken, create, stops, invalidate } = setup({
      token: { token: 'gho_a', source: 'gh' },
      viewers: { gho_a: { login: 'alice' }, gho_oauth: { login: 'alice' } },
    });
    await sessions.current();

    setToken({ token: 'gho_oauth', source: 'oauth' });
    sessions.reset();
    await Promise.resolve();

    expect(stops).toEqual(['alice']);
    expect(invalidate).toHaveBeenCalled();
    expect(sessions.peek()).toBeUndefined();
    await sessions.current();
    expect(create).toHaveBeenCalledTimes(2);
  });

  test('hands the session the token it was opened with while that token is current', async () => {
    const { sessions, contextOf } = setup({ token: { token: 'gho_a', source: 'gh' } });
    await sessions.current();

    await expect(contextOf('alice').token()).resolves.toBe('gho_a');
  });

  test("refuses the old session's calls once the token belongs to someone else, mid-flight", async () => {
    const { sessions, setToken, contextOf } = setup({
      token: { token: 'gho_a', source: 'gh' },
      viewers: { gho_a: { login: 'alice' }, gho_b: { login: 'bob' } },
    });
    await sessions.current();
    const alice = contextOf('alice');

    setToken({ token: 'gho_b', source: 'gh' });

    await expect(alice.token()).rejects.toBeInstanceOf(SessionEndedError);
    await expect(alice.token()).rejects.toThrow(/@alice/);
  });

  test("refuses the old session's calls after sign-out, even when the token comes back", async () => {
    const { sessions, contextOf } = setup({ token: { token: 'gho_a', source: 'oauth' } });
    await sessions.current();
    const alice = contextOf('alice');

    sessions.reset();

    await expect(alice.token()).rejects.toBeInstanceOf(SessionEndedError);
    await sessions.current();
    await expect(alice.token()).rejects.toBeInstanceOf(SessionEndedError);
    await expect(contextOf('alice').token()).resolves.toBe('gho_a');
  });

  test('refuses when there is no token any more', async () => {
    const { sessions, setToken, contextOf } = setup({ token: { token: 'gho_a', source: 'gh' } });
    await sessions.current();

    setToken(undefined);

    await expect(contextOf('alice').token()).rejects.toBeInstanceOf(NotSignedInError);
  });

  test('a token GitHub rejected closes its session and reports it as signed out', async () => {
    const { sessions, stops, invalidate, fetchViewer } = setup({
      token: { token: 'gho_a', source: 'oauth' },
    });
    await sessions.current();
    fetchViewer.mockRejectedValueOnce(new GitHubApiError('Bad credentials', { httpStatus: 401 }));

    sessions.rejected('gho_a');
    await Promise.resolve();

    expect(stops).toEqual(['alice']);
    expect(invalidate).toHaveBeenCalled();
    const error: unknown = await sessions.current().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NotSignedInError);
    expect(error).toMatchObject({ message: expect.stringMatching(/rejected the saved sign-in/) });
  });

  test("ignores a rejection of a token that is not the open session's", async () => {
    const { sessions, stops } = setup({ token: { token: 'gho_a', source: 'gh' } });
    await sessions.current();

    sessions.rejected('gho_old');
    await Promise.resolve();

    expect(stops).toEqual([]);
  });

  test('says which kind of token GitHub rejected', async () => {
    const { sessions } = setup({ token: { token: 'gho_bad', source: 'gh' } });

    await expect(sessions.current()).rejects.toThrow(/gh auth login/);
    await expect(sessions.require()).rejects.toBeInstanceOf(NotSignedInError);
  });

  test('looks the token owner up again after ten minutes', async () => {
    const { sessions, fetchViewer, advance } = setup({ token: { token: 'gho_a', source: 'gh' } });
    await sessions.current();

    advance(9 * 60_000);
    await sessions.current();
    expect(fetchViewer).toHaveBeenCalledTimes(1);

    advance(60_001);
    await sessions.current();
    expect(fetchViewer).toHaveBeenCalledTimes(2);
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

    await expect(sessions.current()).rejects.toThrow(/rejected/);
    await expect(sessions.current()).rejects.toThrow(/rejected/);
    expect(fetchViewer).toHaveBeenCalledTimes(1);

    advance(30_001);
    await expect(sessions.current()).rejects.toThrow(/rejected/);
    expect(fetchViewer).toHaveBeenCalledTimes(2);
  });

  test("keeps the token's known owner while GitHub can't be reached", async () => {
    const { sessions, fetchViewer, create, advance } = setup({
      token: { token: 'gho_a', source: 'gh' },
    });
    const first = await sessions.current();
    fetchViewer.mockRejectedValue(new GitHubNetworkError('GitHub GET /user failed: offline'));

    advance(10 * 60_000 + 1);
    const during = await sessions.current();

    expect(fetchViewer).toHaveBeenCalledTimes(2);
    expect(during?.account.login).toBe('Alice');
    expect(during?.services).toBe(first?.services);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('forgets the known owner once GitHub rejects the token', async () => {
    const { sessions, fetchViewer, advance } = setup({ token: { token: 'gho_a', source: 'gh' } });
    await sessions.current();
    fetchViewer.mockRejectedValue(new GitHubApiError('Bad credentials', { httpStatus: 401 }));

    advance(10 * 60_000 + 1);
    await expect(sessions.current()).rejects.toBeInstanceOf(NotSignedInError);
    fetchViewer.mockRejectedValue(new GitHubNetworkError('GitHub GET /user failed: offline'));
    advance(30_001);

    await expect(sessions.current()).rejects.toBeInstanceOf(GitHubNetworkError);
  });

  test("passes the failure on when GitHub can't be reached for a token it never confirmed", async () => {
    const { sessions, fetchViewer } = setup({ token: { token: 'gho_a', source: 'gh' } });
    fetchViewer.mockRejectedValue(new GitHubNetworkError('GitHub GET /user failed: offline'));

    await expect(sessions.current()).rejects.toBeInstanceOf(GitHubNetworkError);
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
