import { copyFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { createApp, type App } from './app.ts';
import type { CreateMessage } from '../../features/reviews/server/claudeReview.ts';
import type { AppConfig } from '../../platform/server/config.ts';
import { createRouter } from '../../platform/server/router.ts';
import { SOURCE_DIFF, toolMessage } from '../../features/reviews/server/test-utils/claude.ts';
import { fixture } from '../../features/quests/server/test-utils/fixtures.ts';

vi.mock('@cursor/sdk', () => ({
  Agent: { create: vi.fn(), getRun: vi.fn() },
  CursorAgentError: class extends Error {},
  Cursor: { models: { list: vi.fn(async () => []) } },
}));

const FIXTURES = join(import.meta.dirname, '../../platform/server/fixtures/legacy');
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
  host: '127.0.0.1',
  port: 0,
  uiPort: 0,
  stateDir: dir,
  githubClientId: 'Iv1.test',
});

async function start(): Promise<void> {
  app = await createApp({
    config: config(),
    ghToken: async () => ghToken,
    fetch: fakeGitHub,
    createMessage: (...args) => createMessage(...args),
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  });
  server = createServer(createRouter(app.handlers));
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
}

function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; text: string }> {
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
          ...(payload === undefined
            ? {}
            : { 'Content-Length': String(Buffer.byteLength(payload)) }),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text), text }));
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
  await rm(dir, { recursive: true, force: true });
});

describe('createApp', () => {
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
