import { copyFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createApp, type App } from './app.ts';
import type { AppConfig } from './config.ts';
import { createRouter } from './router.ts';

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

/** GitHub as seen through fetch: `/user` per token, and an empty review queue. */
const fakeGitHub = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
  const { pathname } = new URL(url);
  const auth = new Headers(init.headers).get('authorization') ?? '';
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
    createMessage: vi.fn(async () => {
      throw new Error('Claude must not be called in tests');
    }),
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  });
  server = createServer(createRouter(app.handlers));
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
}

function send(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown; text: string }> {
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
          ...(payload === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(payload)) }),
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-app-'));
  ghToken = undefined;
  logins = { [GH_TOKEN]: 'BrianChristensen', [OAUTH_TOKEN]: 'Other-Player' };
  logs = [];
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
    });
    expect(await readFile(join(dir, 'secrets.json'), 'utf8')).not.toContain(OAUTH_TOKEN);
    expect(signedOut.text).not.toContain(OAUTH_TOKEN);
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
