import { copyFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { createApp, type App, type AppOptions, type UserServices } from './app.ts';
import type { AppSettings, SettingsStore } from '../../features/settings/server/index.ts';
import { NotSignedInError } from '../../platform/server/githubApi.ts';
import type { SecretName, SecretStore } from '../../platform/server/secrets.ts';
import type { IdentityFactory } from './identity.ts';
import type { Session } from './sessions.ts';
import {
  type AppStorage,
  createFileStorage,
  MACHINE_SCOPE,
  scopeKey,
  type StorageScope,
  userScope,
} from './storage.ts';
import type { CreateMessage } from '../../features/reviews/server/index.ts';
import type { AppConfig, HostedConfig } from '../../platform/server/config.ts';
import { createRouter } from '../../platform/server/router.ts';
import { HOSTED_CONFIG, LOCAL_CONFIG } from '../../platform/server/test-utils/config.ts';
import { SOURCE_DIFF, toolMessage } from '../../features/reviews/server/test-utils/claude.ts';
import { fixture } from '../../features/quests/server/test-utils/fixtures.ts';

vi.mock('@cursor/sdk', () => ({
  Agent: { create: vi.fn(), getRun: vi.fn() },
  CursorAgentError: class extends Error {},
  Cursor: { models: { list: vi.fn(async () => []) } },
}));

const FIXTURES = join(import.meta.dirname, 'fixtures', 'legacy');
const OAUTH_TOKEN = 'gho_OAUTHSECRET0123456789';
const GH_TOKEN = 'gho_GHCLISECRET0123456789';

let dir: string;
let app: App | undefined;
let server: Server | undefined;
let port: number;
let ghToken: string | undefined;
let logins: Record<string, string>;
let logs: Array<string>;

type Route = (url: URL, init: RequestInit, token: string) => Promise<Response | undefined>;
let route: Route | undefined;
let createMessage: CreateMessage;

/** GitHub as seen through fetch: `/user` per token, and an empty review queue unless `route` answers. */
const fakeGitHub = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
  const parsed = new URL(url);
  const { pathname } = parsed;
  const auth = new Headers(init.headers).get('authorization') ?? '';
  const routed = await route?.(parsed, init, auth.replace(/^Bearer /, ''));
  if (routed) {
    return routed;
  }
  if (pathname === '/user') {
    const login = logins[auth.replace(/^Bearer /, '')];
    return login
      ? Response.json({ login })
      : Response.json({ message: 'Bad credentials' }, { status: 401 });
  }
  if (pathname === '/search/issues') {
    return Response.json({ total_count: 0, incomplete_results: false, items: [] });
  }
  return Response.json({ message: 'Not Found' }, { status: 404 });
});

const config = (): AppConfig => ({
  ...LOCAL_CONFIG,
  stateDir: dir,
  githubClientId: 'Iv1.test',
});

async function start(overrides: Partial<AppOptions> = {}): Promise<void> {
  app = await createApp({
    config: config(),
    ghToken: async () => ghToken,
    fetch: fakeGitHub,
    createMessage: (...args) => createMessage(...args),
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
    ...overrides,
  });
  server = createServer(createRouter(app.handlers, { routes: app.routes }));
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
}

function send(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; text: string; headers: IncomingHttpHeaders }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(payload === undefined
            ? {}
            : { 'Content-Length': String(Buffer.byteLength(payload)) }),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: text ? JSON.parse(text) : undefined,
            text,
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const QUEST_ID = 'Trackunit/circleci-configuration#930';
const QUEST_PULL = '/repos/Trackunit/circleci-configuration/pulls/930';
const QUEST_HEAD = 'd77c66a89e0707ccc917203251d3a3a1efce4182';

/** The recorded review queue: both searches and the batched PR details. */
async function reviewQueue(url: URL): Promise<Response | undefined> {
  if (url.pathname === '/search/issues') {
    const direct = url.searchParams.get('q')?.includes('user-review-requested:@me');
    return new Response(fixture(direct ? 'search-direct.json' : 'search-all.json'));
  }
  if (url.pathname === '/graphql') {
    return new Response(fixture('graphql-batch.json'));
  }
  return undefined;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A forced refresh waits out the first poll, which publishes its quests before it has finished. */
function settleQuests(): ReturnType<typeof send> {
  return send('GET', '/api/quests?refresh=1');
}

async function saveOAuthToken(): Promise<void> {
  await writeFile(
    join(dir, 'secrets.json'),
    JSON.stringify({ version: 1, secrets: { github: OAUTH_TOKEN } }),
    { mode: 0o600 },
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-app-'));
  ghToken = undefined;
  logins = { [GH_TOKEN]: 'BrianChristensen', [OAUTH_TOKEN]: 'Other-Player' };
  logs = [];
  route = undefined;
  createMessage = async () => {
    throw new Error('Claude must not be called in tests');
  };
  fakeGitHub.mockClear();
});

afterEach(async () => {
  app?.close();
  app = undefined;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  // A quest cache write already under way when the app closed can still land in a user folder.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('createApp', () => {
  test('refuses a local config that trusts more than loopback', async () => {
    const wide: AppConfig = Object.assign(config(), { allowedHosts: ['evil.example'] });

    await expect(start({ config: wide })).rejects.toThrow(/loopback Host names/);
  });

  test("opens the gh token owner's game from the migrated legacy state", async () => {
    await copyFile(join(FIXTURES, 'state.json'), join(dir, 'state.json'));
    await copyFile(join(FIXTURES, 'quests.json'), join(dir, 'quests.json'));
    ghToken = GH_TOKEN;
    await start();

    const player = await send('GET', '/api/player');
    const runs = await send('GET', '/api/runs');
    const status = await send('GET', '/api/auth/status');

    expect(player.body).toMatchObject({
      player: { xp: 25, level: 1, counters: { agentReviews: 3, approvals: 1 } },
    });
    expect(runs.body).toEqual({ runs: [expect.anything(), expect.anything(), expect.anything()] });
    expect(status.body).toMatchObject({
      clientIdConfigured: true,
      account: { login: 'BrianChristensen', tokenSource: 'gh' },
    });
    expect(await readFile(join(dir, 'users', 'brianchristensen', 'state.json'), 'utf8')).toBe(
      await readFile(join(FIXTURES, 'state.json'), 'utf8'),
    );
    expect((await readdir(dir)).filter((name) => name.endsWith('.bak'))).toHaveLength(2);
  });

  test('answers notSignedIn on game routes when there is no GitHub token', async () => {
    await start();

    const player = await send('GET', '/api/player');
    const status = await send('GET', '/api/auth/status');

    expect(player).toMatchObject({ status: 401, body: { error: { code: 'notSignedIn' } } });
    expect(status.body).not.toHaveProperty('account');
  });

  test("signing out forgets the OAuth token and falls back to gh's", async () => {
    await writeFile(
      join(dir, 'secrets.json'),
      JSON.stringify({ version: 1, secrets: { github: OAUTH_TOKEN } }),
      { mode: 0o600 },
    );
    ghToken = GH_TOKEN;
    await start();
    expect((await send('GET', '/api/auth/status')).body).toMatchObject({
      account: { login: 'Other-Player', tokenSource: 'oauth' },
    });

    const signedOut = await send('POST', '/api/auth/sign-out');

    expect(signedOut.body).toMatchObject({
      account: { login: 'BrianChristensen', tokenSource: 'gh' },
      fellBackFrom: 'Other-Player',
    });
    expect(await readFile(join(dir, 'secrets.json'), 'utf8')).not.toContain(OAUTH_TOKEN);
    expect(signedOut.text).not.toContain(OAUTH_TOKEN);
  });

  test('refuses an approval that was in flight at sign-out instead of sending it as the gh account', async () => {
    await saveOAuthToken();
    ghToken = GH_TOKEN;
    const headGate = deferred();
    const headRequested = deferred();
    const reviewTokens: Array<string> = [];
    route = async (url, init, token) => {
      const queue = await reviewQueue(url);
      if (queue) {
        return queue;
      }
      if (url.pathname === QUEST_PULL && init.method === 'GET') {
        headRequested.resolve();
        await headGate.promise;
        return Response.json({ head: { sha: QUEST_HEAD } });
      }
      if (url.pathname === `${QUEST_PULL}/reviews`) {
        reviewTokens.push(token);
        return Response.json({ html_url: 'https://github.com/review' });
      }
      return undefined;
    };
    await start();
    expect((await settleQuests()).text).toContain(QUEST_ID);

    const approving = send('POST', `/api/quests/${encodeURIComponent(QUEST_ID)}/approve`, {
      confirm: true,
      headSha: QUEST_HEAD,
    });
    await headRequested.promise;
    const signedOut = await send('POST', '/api/auth/sign-out');
    headGate.resolve();
    const approved = await approving;

    expect(signedOut.body).toMatchObject({ account: { login: 'BrianChristensen' } });
    expect(approved).toMatchObject({ status: 401, body: { error: { code: 'notSignedIn' } } });
    expect(approved.text).toContain('@other-player');
    expect(reviewTokens).toEqual([]);
    const otherState = await readFile(
      join(dir, 'users', 'other-player', 'state.json'),
      'utf8',
    ).catch(() => '{}');
    expect(otherState).not.toContain('"approvals": 1');
  });

  test('stops polling as the old account once the player signs out', async () => {
    await saveOAuthToken();
    ghToken = GH_TOKEN;
    route = async (url) => reviewQueue(url);
    await start();
    await settleQuests();

    fakeGitHub.mockClear();
    await send('POST', '/api/auth/sign-out');
    await send('GET', '/api/quests');

    const tokens = fakeGitHub.mock.calls.map(([, init]) =>
      new Headers(init.headers).get('authorization'),
    );
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens).not.toContain(`Bearer ${OAUTH_TOKEN}`);
  });

  test('a review that finishes after signing out and back in is kept, with its XP', async () => {
    ghToken = GH_TOKEN;
    const replyGate = deferred();
    const claudeCalled = deferred();
    createMessage = vi.fn(async () => {
      claudeCalled.resolve();
      await replyGate.promise;
      return toolMessage({ summary: 'Looks fine.', verdict: 'comment', findings: [] });
    });
    route = async (url) =>
      (await reviewQueue(url)) ??
      (url.pathname.includes('/compare/') ? new Response(SOURCE_DIFF) : undefined);
    await start();
    await send('PUT', '/api/settings/keys/anthropic', { value: 'sk-ant-api03-TEST-0000' });
    await send('PUT', '/api/settings', { reviewProvider: 'claude' });
    await settleQuests();

    const started = await send('POST', `/api/quests/${encodeURIComponent(QUEST_ID)}/review`, {});
    await claudeCalled.promise;
    await send('POST', '/api/auth/sign-out');
    const reopened = await send('GET', '/api/runs');
    replyGate.resolve();
    await vi.waitFor(async () => {
      expect((await send('GET', '/api/runs')).body).toMatchObject({
        runs: [{ status: 'finished' }],
      });
    });

    expect(started.status).toBe(200);
    expect(reopened.body).toMatchObject({ runs: [{ status: 'running' }] });
    expect((await send('GET', '/api/player')).body).toMatchObject({
      player: { counters: { agentReviews: 1 } },
    });
    const saved = z
      .object({ runs: z.array(z.object({ run: z.object({ status: z.string() }) })) })
      .parse(
        JSON.parse(await readFile(join(dir, 'users', 'brianchristensen', 'state.json'), 'utf8')),
      );
    expect(saved.runs.map(({ run }) => run.status)).toEqual(['finished']);
  });

  test("answers upstreamFailed, not a server error, when GitHub can't confirm the account", async () => {
    ghToken = GH_TOKEN;
    route = async (url) =>
      url.pathname === '/user'
        ? Response.json({ message: 'Service Unavailable' }, { status: 503 })
        : undefined;
    await start();

    const player = await send('GET', '/api/player');

    expect(player).toMatchObject({ status: 502, body: { error: { code: 'upstreamFailed' } } });
    expect(player.text).toContain('Service Unavailable');
  });

  test('a sign-in GitHub has revoked shows as signed out with a reason', async () => {
    await saveOAuthToken();
    route = async (url) => reviewQueue(url);
    await start();
    expect((await send('GET', '/api/auth/status')).body).toMatchObject({
      account: { login: 'Other-Player' },
    });
    await settleQuests();

    delete logins[OAUTH_TOKEN];
    route = async () => Response.json({ message: 'Bad credentials' }, { status: 401 });
    const quests = await send('GET', '/api/quests?refresh=1');
    route = undefined;
    const status = await send('GET', '/api/auth/status');

    expect(quests).toMatchObject({ status: 401, body: { error: { code: 'notSignedIn' } } });
    expect(status.body).not.toHaveProperty('account');
    expect(status.body).toMatchObject({
      error: expect.stringMatching(/rejected the saved sign-in/),
    });
  });

  test('health and settings report a key saved in Settings without revealing it', async () => {
    await start();
    const key = 'sk-ant-api03-SAVEDSECRET-9876';

    await send('PUT', '/api/settings/keys/anthropic', { value: key });
    const health = await send('GET', '/api/health');

    expect(health.body).toMatchObject({ config: { anthropicApiKey: true, cursorApiKey: false } });
    expect(health.text).not.toContain(key);
    expect((await stat(join(dir, 'secrets.json'))).mode & 0o777).toBe(0o600);
    expect(logs.join('\n')).not.toContain(key);
  });

  test('asks for the Anthropic key before looking up the quest when Claude is selected', async () => {
    ghToken = GH_TOKEN;
    await start();
    await send('PUT', '/api/settings', { reviewProvider: 'claude' });

    const response = await send(
      'POST',
      `/api/quests/${encodeURIComponent('Acme/widgets#200')}/review`,
      {},
    );

    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: 'missingConfig', provider: 'claude' } },
    });
  });
});

/**
 * A stand-in for a hosted sign-in: the `X-Test-Token` header names the GitHub token, and every
 * login keeps its own session open at the same time. It names the session in an `X-Test-Session`
 * response header, as a hosted resolver would set its cookie, and releases a player who signs out.
 */
const headerIdentity: IdentityFactory<UserServices> = async ({
  openUser,
  fetchViewer,
  releaseUser,
}) => {
  const open = new Map<string, Promise<Session<UserServices>>>();
  const sessionOf = async (req: IncomingMessage, res: ServerResponse) => {
    const token = req.headers['x-test-token'];
    if (typeof token !== 'string') {
      return undefined;
    }
    const { login } = await fetchViewer(token);
    const key = login.toLowerCase();
    let session = open.get(key);
    if (!session) {
      session = openUser({ login: key, token: async () => token }).then((services) => ({
        account: { login, tokenSource: 'oauth' as const },
        services,
      }));
      open.set(key, session);
    }
    res.setHeader('X-Test-Session', key);
    return session;
  };
  return {
    resolve: sessionOf,
    scope: async (req, res) => {
      const session = await sessionOf(req, res);
      if (!session) {
        throw new NotSignedInError();
      }
      return userScope(session.account.login);
    },
    scopeFor: userScope,
    signOut: async (req, res) => {
      const session = await sessionOf(req, res);
      if (!session) {
        return undefined;
      }
      const key = session.account.login.toLowerCase();
      open.delete(key);
      session.services.stop();
      releaseUser(key);
      return session.account;
    },
    rejected: () => undefined,
    warmUp: async () => undefined,
    close: () => {
      for (const session of open.values()) {
        void session.then(
          ({ services }) => services.stop(),
          () => undefined,
        );
      }
    },
    routes: [
      {
        method: 'GET',
        path: '/auth/test',
        handle: (_req, res) => {
          res.writeHead(302, { Location: '/' }).end();
        },
      },
    ],
  };
};

function memorySettings(): SettingsStore {
  let current: AppSettings = { reviewProvider: 'cursor', models: {} };
  return {
    get: () => current,
    update: async (patch) => {
      current = { ...current, reviewProvider: patch.reviewProvider ?? current.reviewProvider };
      return current;
    },
  };
}

function memorySecrets(): SecretStore {
  const saved = new Map<SecretName, string>();
  return {
    get: (name) => saved.get(name),
    set: async (name, value) => {
      saved.set(name, value);
    },
    delete: async (name) => {
      saved.delete(name);
    },
  };
}

/** The file storage for games, with keys and settings kept per scope in memory as a hosted store would. */
function perUserStorage(): AppStorage {
  const files = createFileStorage(dir, { info: () => undefined, warn: () => undefined });
  const settings = new Map<string, SettingsStore>();
  const secrets = new Map<string, SecretStore>();
  const scoped =
    <TStore>(stores: Map<string, TStore>, create: () => TStore) =>
    async (scope: StorageScope): Promise<TStore> => {
      const key = scopeKey(scope);
      const store = stores.get(key) ?? create();
      stores.set(key, store);
      return store;
    };
  return {
    ...files,
    secrets: scoped(secrets, memorySecrets),
    settings: scoped(settings, memorySettings),
  };
}

describe('createApp with an injected identity and storage', () => {
  const as = (token: string) => ({ 'X-Test-Token': token });

  test('opens each signed-in player their own game, side by side', async () => {
    await start({ identity: headerIdentity, storage: perUserStorage() });

    const first = await send('GET', '/api/player', undefined, as(GH_TOKEN));
    const second = await send('GET', '/api/player', undefined, as(OAUTH_TOKEN));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await readdir(join(dir, 'users'))).sort()).toEqual([
      'brianchristensen',
      'other-player',
    ]);
  });

  test("keeps each player's settings apart", async () => {
    await start({ identity: headerIdentity, storage: perUserStorage() });

    await send('PUT', '/api/settings', { reviewProvider: 'claude' }, as(GH_TOKEN));

    expect((await send('GET', '/api/settings', undefined, as(GH_TOKEN))).body).toMatchObject({
      reviewProvider: 'claude',
    });
    expect((await send('GET', '/api/settings', undefined, as(OAUTH_TOKEN))).body).toMatchObject({
      reviewProvider: 'cursor',
    });
  });

  test('answers notSignedIn on settings routes when the identity needs a sign-in', async () => {
    await start({ identity: headerIdentity, storage: perUserStorage() });

    const settings = await send('GET', '/api/settings');

    expect(settings).toMatchObject({ status: 401, body: { error: { code: 'notSignedIn' } } });
  });

  test('lets the identity write headers on the response, as for a session cookie', async () => {
    await start({ identity: headerIdentity, storage: perUserStorage() });

    const player = await send('GET', '/api/player', undefined, as(GH_TOKEN));

    expect(player.headers['x-test-session']).toBe('brianchristensen');
  });

  test("serves the identity's own routes outside the JSON API", async () => {
    await start({ identity: headerIdentity, storage: perUserStorage() });

    const response = await send('GET', '/auth/test');

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/');
  });

  test("never falls back to the gh CLI's token or offers the device flow (local mode)", async () => {
    ghToken = GH_TOKEN;
    await start({ identity: headerIdentity, storage: perUserStorage() });

    const player = await send('GET', '/api/player');
    const device = await send('POST', '/api/auth/device', {}, as(GH_TOKEN));
    const status = await send('GET', '/api/auth/status', undefined, as(GH_TOKEN));

    expect(player).toMatchObject({ status: 401, body: { error: { code: 'notSignedIn' } } });
    expect(device).toMatchObject({ status: 409, body: { error: { code: 'missingConfig' } } });
    expect(status.body).toMatchObject({
      clientIdConfigured: false,
      account: { login: 'BrianChristensen' },
    });
  });
});

const hostedConfig = (): HostedConfig => ({ ...HOSTED_CONFIG, stateDir: dir });

/** `perUserStorage`, noting every scope whose keys or settings were opened. */
function recordingStorage(): { storage: AppStorage; scopes: Array<string> } {
  const inner = perUserStorage();
  const scopes: Array<string> = [];
  return {
    scopes,
    storage: {
      ...inner,
      secrets: async (scope) => {
        scopes.push(scopeKey(scope));
        return inner.secrets(scope);
      },
      settings: async (scope) => {
        scopes.push(scopeKey(scope));
        return inner.settings(scope);
      },
    },
  };
}

describe('createApp in hosted mode', () => {
  const as = (token: string) => ({ 'X-Test-Token': token });

  test('refuses to start without an identity and storage for many players', async () => {
    await expect(start({ config: hostedConfig() })).rejects.toThrow(/hosted mode needs/i);
    await expect(start({ config: hostedConfig(), identity: headerIdentity })).rejects.toThrow(
      /hosted mode needs/i,
    );
  });

  test('refuses API keys in the config, which every player would share', async () => {
    const withKey: AppConfig = Object.assign(hostedConfig(), { cursorApiKey: 'key_operator' });

    await expect(
      start({ config: withKey, identity: headerIdentity, storage: perUserStorage() }),
    ).rejects.toThrow(/API keys/);
  });

  test("never opens the machine's keys or settings", async () => {
    const { storage, scopes } = recordingStorage();
    await start({ config: hostedConfig(), identity: headerIdentity, storage });

    await send('GET', '/api/player', undefined, as(GH_TOKEN));
    await send('GET', '/api/settings', undefined, as(GH_TOKEN));

    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes).not.toContain('machine');
  });

  test('refuses an identity that puts a player on the machine scope', async () => {
    const { storage, scopes } = recordingStorage();
    const machineIdentity: IdentityFactory<UserServices> = async (context) => ({
      ...(await headerIdentity(context)),
      scope: async () => MACHINE_SCOPE,
      scopeFor: () => MACHINE_SCOPE,
    });
    await start({ config: hostedConfig(), identity: machineIdentity, storage });

    const settings = await send('GET', '/api/settings', undefined, as(GH_TOKEN));
    const player = await send('GET', '/api/player', undefined, as(GH_TOKEN));

    expect(settings.status).toBe(500);
    expect(player.status).toBe(500);
    expect(scopes).not.toContain('machine');
  });

  test("reopens a released player's game and keys from storage", async () => {
    const { storage, scopes } = recordingStorage();
    let gameStates = 0;
    await start({
      config: hostedConfig(),
      identity: headerIdentity,
      storage: {
        ...storage,
        gameState: async (login) => {
          gameStates += 1;
          return storage.gameState(login);
        },
      },
    });
    await send('GET', '/api/player', undefined, as(GH_TOKEN));
    await send('GET', '/api/player', undefined, as(GH_TOKEN));
    expect(gameStates).toBe(1);

    await send('POST', '/api/auth/sign-out', {}, as(GH_TOKEN));
    await send('GET', '/api/player', undefined, as(GH_TOKEN));

    expect(gameStates).toBe(2);
    expect(scopes.filter((key) => key === 'user:brianchristensen')).toHaveLength(4);
  });

  test('answers the health check without saying which keys exist', async () => {
    await start({ config: hostedConfig(), identity: headerIdentity, storage: perUserStorage() });

    expect((await send('GET', '/api/health')).body).toEqual({ ok: true });
  });
});
