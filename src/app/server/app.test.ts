import { randomBytes } from 'node:crypto';
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { createApp, type App, type AppOptions, type UserServices } from './app.ts';
import type { AppSettings, SettingsStore } from '../../features/settings/server/index.ts';
import { MasterKeyring } from '../../platform/server/envelope.ts';
import { NotSignedInError } from '../../platform/server/githubApi.ts';
import type { SecretName, SecretStore } from '../../platform/server/secrets.ts';
import { openTestDatabase, type TestDatabase } from '../../platform/server/test-utils/postgres.ts';
import { openPostgresStorage } from './postgresStorage.ts';
import type { IdentityContext, IdentityFactory } from './identity.ts';
import type { Session } from './sessions.ts';
import {
  type AppStorage,
  createFileStorage,
  MACHINE_SCOPE,
  scopeKey,
  type StorageScope,
  userScope,
} from './storage.ts';
import { type GitHubUser, githubUser } from '../../platform/server/githubUser.ts';
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
/** Overrides the account id `/user` answers with for a token, as for a login another account took. */
let tokenIds: Record<string, number>;

/** GitHub's account id for each login the fake GitHub answers for. */
const ACCOUNT_IDS: Record<string, number> = { brianchristensen: 4101, 'other-player': 4102 };
const accountOf = (login: string): GitHubUser => ({
  id: ACCOUNT_IDS[login.toLowerCase()] ?? 4199,
  login: login.toLowerCase(),
});
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
      ? Response.json({ id: tokenIds[auth.replace(/^Bearer /, '')] ?? accountOf(login).id, login })
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
  tokenIds = {};
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
 * account keeps its own session open at the same time. It names the session in an `X-Test-Session`
 * response header, as a hosted resolver would set its cookie, and releases a player who signs out.
 */
const headerIdentity: IdentityFactory<UserServices> = async ({
  openUser,
  fetchViewer,
  releaseUser,
}) => {
  const open = new Map<string, Promise<Session<UserServices>>>();
  const signedIn = async (req: IncomingMessage, res: ServerResponse) => {
    const token = req.headers['x-test-token'];
    if (typeof token !== 'string') {
      return undefined;
    }
    const viewer = await fetchViewer(token);
    const user = githubUser(viewer.id, viewer.login);
    const key = String(user.id);
    let session = open.get(key);
    if (!session) {
      session = openUser({ user, token: async () => token }).then((services) => ({
        account: { login: viewer.login, tokenSource: 'oauth' as const },
        services,
      }));
      open.set(key, session);
    }
    res.setHeader('X-Test-Session', key);
    return { user, key, session: await session };
  };
  return {
    resolve: async (req, res) => (await signedIn(req, res))?.session,
    scope: async (req, res) => {
      const signed = await signedIn(req, res);
      if (!signed) {
        throw new NotSignedInError();
      }
      return userScope(signed.user);
    },
    scopeFor: userScope,
    signOut: async (req, res) => {
      const signed = await signedIn(req, res);
      if (!signed) {
        return undefined;
      }
      res.removeHeader('X-Test-Session');
      open.delete(signed.key);
      signed.session.services.stop();
      releaseUser(signed.user);
      return signed.session.account;
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

    expect(player.headers['x-test-session']).toBe(String(accountOf('brianchristensen').id));
  });

  test("serves the identity's own routes outside the JSON API", async () => {
    await start({ identity: headerIdentity, storage: perUserStorage() });

    const response = await send('GET', '/auth/test');

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/');
  });

  test('refuses cross-site routes in local mode, whose sign-in needs no callback', async () => {
    const crossSiteIdentity: IdentityFactory<UserServices> = async (context) => ({
      ...(await headerIdentity(context)),
      routes: [{ method: 'GET', path: '/auth/cross', crossSite: true, handle: () => undefined }],
    });

    await expect(start({ identity: crossSiteIdentity, storage: perUserStorage() })).rejects.toThrow(
      /GET \/auth\/cross.*hosted mode/i,
    );
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
        gameState: async (user) => {
          gameStates += 1;
          return storage.gameState(user);
        },
      },
    });
    await send('GET', '/api/player', undefined, as(GH_TOKEN));
    await send('GET', '/api/player', undefined, as(GH_TOKEN));
    expect(gameStates).toBe(1);

    await send('POST', '/api/auth/sign-out', {}, as(GH_TOKEN));
    await send('GET', '/api/player', undefined, as(GH_TOKEN));

    expect(gameStates).toBe(2);
    expect(scopes.filter((key) => key === `user:${accountOf('brianchristensen').id}`)).toHaveLength(
      4,
    );
  });

  test("keeps one copy of a renamed player's game, and records each session's login", async () => {
    let context: IdentityContext<UserServices> | undefined;
    const games: Array<string> = [];
    const registered: Array<GitHubUser> = [];
    const inner = perUserStorage();
    await start({
      config: hostedConfig(),
      identity: async (given) => {
        context = given;
        return headerIdentity(given);
      },
      storage: {
        ...inner,
        gameState: async (user) => {
          games.push(user.login);
          return inner.gameState(user);
        },
        registerUser: async (user) => {
          registered.push(user);
        },
      },
    });
    if (!context) {
      throw new Error('the identity factory was not called');
    }
    const token = async () => GH_TOKEN;

    const before = await context.openUser({ user: { id: 4101, login: 'before' }, token });
    before.stop();
    const after = await context.openUser({ user: { id: 4101, login: 'after' }, token });
    after.stop();

    expect(games).toEqual(['before']);
    expect(registered).toEqual([
      { id: 4101, login: 'before' },
      { id: 4101, login: 'after' },
    ]);
  });

  test('serves cross-site routes, such as an OAuth callback from github.com', async () => {
    const crossSiteIdentity: IdentityFactory<UserServices> = async (context) => ({
      ...(await headerIdentity(context)),
      routes: [
        {
          method: 'GET',
          path: '/auth/callback',
          crossSite: true,
          handle: (_req, res) => {
            res.writeHead(302, { Location: '/' }).end();
          },
        },
      ],
    });
    await start({ config: hostedConfig(), identity: crossSiteIdentity, storage: perUserStorage() });

    const response = await send('GET', '/auth/callback', undefined, {
      'Sec-Fetch-Site': 'cross-site',
    });

    expect(response.status).toBe(302);
  });

  test('answers a sign-out as signed out, without reopening the session', async () => {
    let gameStates = 0;
    const storage = perUserStorage();
    await start({
      config: hostedConfig(),
      identity: headerIdentity,
      storage: {
        ...storage,
        gameState: async (user) => {
          gameStates += 1;
          return storage.gameState(user);
        },
      },
    });
    await send('GET', '/api/player', undefined, as(GH_TOKEN));

    const signedOut = await send('POST', '/api/auth/sign-out', {}, as(GH_TOKEN));

    expect(signedOut.status).toBe(200);
    expect(signedOut.body).not.toHaveProperty('account');
    expect(signedOut.headers['x-test-session']).toBeUndefined();
    expect(gameStates).toBe(1);
  });

  test('answers the health check without saying which keys exist', async () => {
    await start({ config: hostedConfig(), identity: headerIdentity, storage: perUserStorage() });

    expect((await send('GET', '/api/health')).body).toEqual({ ok: true });
  });
});

describe('createApp on Postgres storage', () => {
  const as = (token: string) => ({ 'X-Test-Token': token });
  const ANTHROPIC_KEY = 'sk-ant-api03-POSTGRES-0000';
  let database: TestDatabase;
  let postgres: () => Promise<AppStorage>;

  beforeAll(async () => {
    database = await openTestDatabase();
    const keyring = MasterKeyring.fromConfig({ current: randomBytes(32).toString('base64') });
    postgres = () =>
      openPostgresStorage(database.db, { keyring, warn: (message) => logs.push(message) });
  });

  beforeEach(async () => {
    await database.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await database.close();
  });

  test('hands the identity resolver the database, for its own tables such as sessions', async () => {
    let seen: IdentityContext<UserServices>['database'];
    const identity: IdentityFactory<UserServices> = async (context) => {
      seen = context.database;
      return headerIdentity(context);
    };
    await start({
      config: hostedConfig(),
      identity,
      storage: await postgres(),
      database: database.db,
    });

    const result = await seen?.transaction((tx) =>
      tx.query('SELECT count(*)::int AS n FROM users'),
    );
    expect(result?.rows).toEqual([{ n: 0 }]);
    expect(seen).not.toHaveProperty('close');
  });

  test("hands the identity resolver each player's secrets, kept until the player is released", async () => {
    let context: IdentityContext<UserServices> | undefined;
    const identity: IdentityFactory<UserServices> = async (given) => {
      context = given;
      return headerIdentity(given);
    };
    await start({ config: hostedConfig(), identity, storage: await postgres() });
    const player = accountOf('brianchristensen');
    if (!context) {
      throw new Error('the identity factory was not called');
    }

    const secrets = await context.secretsFor(player);
    await secrets.set('github', 'gho_sealed_token');
    await send('PUT', '/api/settings/keys/anthropic', { value: ANTHROPIC_KEY }, as(GH_TOKEN));

    expect(await context.secretsFor(player)).toBe(secrets);
    expect(secrets.get('anthropic')).toBe(ANTHROPIC_KEY);
    expect((await context.secretsFor(accountOf('other-player'))).get('github')).toBeUndefined();
    context.releaseUser(player);
    const reopened = await context.secretsFor(player);
    expect(reopened).not.toBe(secrets);
    expect(reopened.get('github')).toBe('gho_sealed_token');
  });

  test("tells the browser only that the sign-in couldn't be checked, and logs why", async () => {
    await start({
      config: hostedConfig(),
      identity: async (context) => ({
        ...(await headerIdentity(context)),
        resolve: async () => {
          throw new Error("octocat's github key could not be decrypted: tag mismatch");
        },
      }),
      storage: perUserStorage(),
    });

    const status = await send('GET', '/api/auth/status');

    expect(status.body).toMatchObject({
      error: "Couldn't check who is signed in; see the server log",
    });
    expect(status.text).not.toContain('decrypted');
    expect(logs.join('\n')).toMatch(/could not be decrypted: tag mismatch/);
  });

  test('gives the identity resolver no database when the app has none', async () => {
    let seen: IdentityContext<UserServices>['database'] | 'unset' = 'unset';
    await start({
      config: hostedConfig(),
      identity: async (context) => {
        seen = context.database;
        return headerIdentity(context);
      },
      storage: await postgres(),
    });

    expect(seen).toBeUndefined();
  });

  test("keeps each player's settings, time zone and encrypted keys apart", async () => {
    await start({ config: hostedConfig(), identity: headerIdentity, storage: await postgres() });

    await send(
      'PUT',
      '/api/settings',
      { reviewProvider: 'claude', timeZone: 'Asia/Tokyo' },
      as(GH_TOKEN),
    );
    await send('PUT', '/api/settings/keys/anthropic', { value: ANTHROPIC_KEY }, as(GH_TOKEN));

    const mine = await send('GET', '/api/settings', undefined, as(GH_TOKEN));
    const theirs = await send('GET', '/api/settings', undefined, as(OAUTH_TOKEN));
    expect(mine.body).toMatchObject({
      reviewProvider: 'claude',
      timeZone: 'Asia/Tokyo',
      keys: { anthropic: { set: true, source: 'settings', last4: '0000' } },
    });
    expect(mine.text).not.toContain(ANTHROPIC_KEY);
    expect(theirs.body).toMatchObject({
      reviewProvider: 'cursor',
      keys: { anthropic: { set: false } },
    });
    expect(theirs.body).not.toHaveProperty('timeZone');
    const sealed = JSON.stringify(
      (await database.db.query('SELECT sealed FROM user_secrets')).rows,
    );
    expect(sealed).not.toContain(ANTHROPIC_KEY);
  });

  test("never shows a login's new owner the keys or game of the account that held it", async () => {
    await start({ config: hostedConfig(), identity: headerIdentity, storage: await postgres() });
    await send('PUT', '/api/settings/keys/anthropic', { value: ANTHROPIC_KEY }, as(GH_TOKEN));
    const reused = 'gho_login_reused';
    logins[reused] = 'BrianChristensen';
    tokenIds[reused] = 777_000_001;

    const settings = await send('GET', '/api/settings', undefined, as(reused));

    expect(settings.body).toMatchObject({ keys: { anthropic: { set: false } } });
    expect(logs.join('\n')).toMatch(/brianchristensen now belongs to GitHub id 777000001/);
  });

  test("shows the streak by the calendar of the player's time zone", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 07:00 UTC on the 12th is still the 11th in Los Angeles, the day after the last review.
    const storage = await postgres();
    const player = accountOf('brianchristensen');
    vi.setSystemTime(new Date('2026-11-09T07:00:00Z'));
    await (await storage.settings(userScope(player))).update({ timeZone: 'UTC' });
    vi.setSystemTime(new Date('2026-11-12T07:00:00Z'));
    const seeded = await storage.gameState(player);
    await seeded.update((state) => ({
      ...state,
      game: { ...state.game, streakDays: 3, lastReviewDate: '2026-11-10' },
    }));
    await start({ config: hostedConfig(), identity: headerIdentity, storage });

    const inUtc = await send('GET', '/api/player', undefined, as(GH_TOKEN));
    await send('PUT', '/api/settings', { timeZone: 'America/Los_Angeles' }, as(GH_TOKEN));
    const inLosAngeles = await send('GET', '/api/player', undefined, as(GH_TOKEN));

    expect(inUtc.body).toMatchObject({ player: { streakDays: 0 } });
    expect(inLosAngeles.body).toMatchObject({ player: { streakDays: 3 } });
  });

  test('lets a player change their time zone once a day, so streaks follow one calendar', async () => {
    await start({ config: hostedConfig(), identity: headerIdentity, storage: await postgres() });

    const first = await send('PUT', '/api/settings', { timeZone: 'UTC' }, as(GH_TOKEN));
    const second = await send(
      'PUT',
      '/api/settings',
      { timeZone: 'Pacific/Kiritimati' },
      as(GH_TOKEN),
    );

    expect(first.status).toBe(200);
    expect(second).toMatchObject({ status: 429, body: { error: { code: 'rateLimited' } } });
  });
});
