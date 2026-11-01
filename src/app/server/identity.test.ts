import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, test, vi } from 'vitest';

import type { GitHubViewer } from '../../features/quests/server/index.ts';
import { GitHubApiError } from '../../platform/server/githubApi.ts';
import type { SecretName, SecretStore } from '../../platform/server/secrets.ts';
import { LocalIdentityResolver } from './identity.ts';
import type { SessionFactory } from './sessions.ts';
import { MACHINE_SCOPE } from './storage.ts';

const GH_TOKEN = 'gho_GHCLI';
const OAUTH_TOKEN = 'gho_OAUTH';

/** Any request and response: local mode never looks at them. */
const req = new IncomingMessage(new Socket());
const res = new ServerResponse(req);

/** GitHub's device flow endpoints, answering each token poll from `tokenReplies` in order. */
function deviceGitHub(tokenReplies: Array<unknown>) {
  return vi.fn(async (url: string | URL | Request): Promise<Response> => {
    if (String(url).endsWith('/login/device/code')) {
      return Response.json({
        device_code: 'dev-code',
        user_code: 'WDJB-MJHT',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 0,
      });
    }
    return Response.json(tokenReplies.shift() ?? { error: 'authorization_pending' });
  });
}

function setup(options: { githubClientId?: string; tokenReplies?: Array<unknown> } = {}) {
  const saved = new Map<SecretName, string>();
  const secrets: SecretStore = {
    get: (name) => saved.get(name),
    set: async (name, value) => {
      saved.set(name, value);
    },
    delete: async (name) => {
      saved.delete(name);
    },
  };
  const viewers: Record<string, GitHubViewer> = {
    [GH_TOKEN]: { id: 1001, login: 'Alice' },
    [OAUTH_TOKEN]: { id: 1002, login: 'Bob' },
  };
  const fetchViewer = vi.fn(async (token: string) => {
    const viewer = viewers[token];
    if (!viewer) {
      throw new GitHubApiError('Bad credentials', { httpStatus: 401 });
    }
    return viewer;
  });
  const stopped: Array<string> = [];
  const openUser = vi.fn<SessionFactory>(async ({ user: { login } }) => ({
    login,
    stop: () => stopped.push(login),
  }));
  let ghToken: string | undefined = GH_TOKEN;
  const identity = new LocalIdentityResolver({
    secrets,
    ghToken: async () => ghToken,
    openUser,
    fetchViewer,
    log: () => undefined,
    warn: () => undefined,
    githubClientId: options.githubClientId,
    fetch: deviceGitHub(options.tokenReplies ?? []),
  });
  return {
    identity,
    saved,
    fetchViewer,
    openUser,
    stopped,
    setGhToken: (token: string | undefined) => {
      ghToken = token;
    },
  };
}

describe('LocalIdentityResolver', () => {
  test("acts as the gh token's owner for every request", async () => {
    const { identity } = setup();

    const session = await identity.resolve(req, res);

    expect(session?.account).toEqual({ login: 'Alice', tokenSource: 'gh' });
    expect((await identity.resolve(req, res))?.services).toBe(session?.services);
  });

  test('resolves nobody without a token', async () => {
    const { identity, setGhToken } = setup();
    setGhToken(undefined);

    await expect(identity.resolve(req, res)).resolves.toBeUndefined();
  });

  test('keeps keys and settings machine-wide without asking GitHub who is signed in', async () => {
    const { identity, fetchViewer } = setup();

    await expect(identity.scope(req, res)).resolves.toEqual(MACHINE_SCOPE);
    expect(identity.scopeFor({ id: 1001, login: 'alice' })).toEqual(MACHINE_SCOPE);
    expect(fetchViewer).not.toHaveBeenCalled();
  });

  test("signing in saves the OAuth token and switches to its owner's game", async () => {
    const { identity, saved, stopped } = setup();
    await identity.resolve(req, res);

    await identity.signIn(OAUTH_TOKEN);
    const session = await identity.resolve(req, res);

    expect(saved.get('github')).toBe(OAUTH_TOKEN);
    expect(session?.account).toEqual({ login: 'Bob', tokenSource: 'oauth' });
    expect(stopped).toEqual(['alice']);
  });

  test('signing out forgets the OAuth token and names the account it was', async () => {
    const { identity, saved, stopped } = setup();
    await identity.signIn(OAUTH_TOKEN);
    await identity.resolve(req, res);

    const signedOut = await identity.signOut(req, res);

    expect(signedOut).toEqual({ login: 'Bob', tokenSource: 'oauth' });
    expect(saved.has('github')).toBe(false);
    expect(stopped).toEqual(['bob']);
    expect((await identity.resolve(req, res))?.account.login).toBe('Alice');
  });

  test('a token GitHub rejected stops the session using it', async () => {
    const { identity, stopped } = setup();
    await identity.resolve(req, res);

    identity.rejected(GH_TOKEN);

    await vi.waitFor(() => expect(stopped).toEqual(['alice']));
  });

  test('warming up opens the current player without a request', async () => {
    const { identity, openUser } = setup();

    await identity.warmUp();

    expect(openUser).toHaveBeenCalledWith(
      expect.objectContaining({ user: { id: 1001, login: 'alice' } }),
    );
  });

  test('closing stops the open session', async () => {
    const { identity, stopped } = setup();
    await identity.resolve(req, res);

    identity.close();

    await vi.waitFor(() => expect(stopped).toEqual(['alice']));
  });
});

describe('LocalIdentityResolver device flow', () => {
  test('is offered, but not configured, without a client ID', () => {
    const { identity } = setup();

    expect(identity.deviceFlow.isConfigured()).toBe(false);
  });

  test("saves the token it gets and switches to its owner's game", async () => {
    const { identity, saved } = setup({
      githubClientId: 'Iv1.test',
      tokenReplies: [{ access_token: OAUTH_TOKEN }],
    });
    await identity.resolve(req, res);

    await identity.deviceFlow.start();
    await identity.deviceFlow.settled();

    expect(identity.deviceFlow.status()).toEqual({ state: 'complete' });
    expect(saved.get('github')).toBe(OAUTH_TOKEN);
    expect((await identity.resolve(req, res))?.account.login).toBe('Bob');
  });

  test('signing out cancels a sign-in in progress', async () => {
    const { identity, saved } = setup({ githubClientId: 'Iv1.test' });
    await identity.deviceFlow.start();

    await identity.signOut(req, res);
    await identity.deviceFlow.settled();

    expect(identity.deviceFlow.status()).toEqual({ state: 'idle' });
    expect(saved.has('github')).toBe(false);
  });
});
