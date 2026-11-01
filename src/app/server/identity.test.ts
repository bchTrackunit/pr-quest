import { IncomingMessage } from 'node:http';
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

/** Any request: local mode never looks at it. */
const req = new IncomingMessage(new Socket());

function setup() {
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
    [GH_TOKEN]: { login: 'Alice' },
    [OAUTH_TOKEN]: { login: 'Bob' },
  };
  const fetchViewer = vi.fn(async (token: string) => {
    const viewer = viewers[token];
    if (!viewer) {
      throw new GitHubApiError('Bad credentials', { httpStatus: 401 });
    }
    return viewer;
  });
  const stopped: Array<string> = [];
  const openUser = vi.fn<SessionFactory>(async ({ login }) => ({
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

    const session = await identity.resolve(req);

    expect(session?.account).toEqual({ login: 'Alice', tokenSource: 'gh' });
    expect(identity.peek(req)).toBe(session);
  });

  test('resolves nobody without a token', async () => {
    const { identity, setGhToken } = setup();
    setGhToken(undefined);

    await expect(identity.resolve(req)).resolves.toBeUndefined();
  });

  test('keeps keys and settings machine-wide without asking GitHub who is signed in', async () => {
    const { identity, fetchViewer } = setup();

    await expect(identity.scope(req)).resolves.toEqual(MACHINE_SCOPE);
    expect(identity.scopeFor('alice')).toEqual(MACHINE_SCOPE);
    expect(fetchViewer).not.toHaveBeenCalled();
  });

  test("signing in saves the OAuth token and switches to its owner's game", async () => {
    const { identity, saved, stopped } = setup();
    await identity.resolve(req);

    await identity.signIn(OAUTH_TOKEN);
    const session = await identity.resolve(req);

    expect(saved.get('github')).toBe(OAUTH_TOKEN);
    expect(session?.account).toEqual({ login: 'Bob', tokenSource: 'oauth' });
    expect(stopped).toEqual(['alice']);
  });

  test('signing out forgets the OAuth token and names the account it was', async () => {
    const { identity, saved, stopped } = setup();
    await identity.signIn(OAUTH_TOKEN);
    await identity.resolve(req);

    const signedOut = await identity.signOut(req);

    expect(signedOut).toEqual({ login: 'Bob', tokenSource: 'oauth' });
    expect(saved.has('github')).toBe(false);
    expect(stopped).toEqual(['bob']);
    expect((await identity.resolve(req))?.account.login).toBe('Alice');
  });

  test('a token GitHub rejected stops the session using it', async () => {
    const { identity, stopped } = setup();
    await identity.resolve(req);

    identity.rejected(GH_TOKEN);

    await vi.waitFor(() => expect(stopped).toEqual(['alice']));
  });

  test('warming up opens the current player without a request', async () => {
    const { identity, openUser } = setup();

    await identity.warmUp();

    expect(openUser).toHaveBeenCalledWith(expect.objectContaining({ login: 'alice' }));
  });

  test('closing stops the open session', async () => {
    const { identity, stopped } = setup();
    await identity.resolve(req);

    identity.close();

    await vi.waitFor(() => expect(stopped).toEqual(['alice']));
  });
});
