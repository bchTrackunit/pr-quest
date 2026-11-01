import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { AppConfig } from '../../platform/server/config.ts';
import type { SecretName, SecretStore } from '../../platform/server/secrets.ts';
import { LOCAL_CONFIG } from '../../platform/server/test-utils/config.ts';
import { type RunningServer, startServer, type ServerOverrides } from './server.ts';

vi.mock('@cursor/sdk', () => ({
  Agent: { create: vi.fn(), getRun: vi.fn() },
  CursorAgentError: class extends Error {},
  Cursor: { models: { list: vi.fn(async () => []) } },
}));

let dir: string;
let running: RunningServer | undefined;
let logs: Array<string>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-server-'));
  logs = [];
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  await rm(dir, { recursive: true, force: true });
});

const offline: ServerOverrides = {
  ghToken: async () => undefined,
  fetch: async () => Response.json({ message: 'offline' }, { status: 503 }),
  info: (message) => logs.push(message),
  warn: (message) => logs.push(message),
};

async function start(
  config: Partial<AppConfig> = {},
  overrides: ServerOverrides = {},
): Promise<RunningServer> {
  running = await startServer(
    { ...LOCAL_CONFIG, stateDir: join(dir, 'state'), ...config },
    { ...offline, ...overrides },
  );
  return running;
}

describe('startServer', () => {
  test('listens on 127.0.0.1 on a free port when asked for port 0', async () => {
    const server = await start();

    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
  });

  test('trusts requests from its own origin once the port is known', async () => {
    const server = await start();

    const response = await fetch(`${server.url}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: server.url },
      body: JSON.stringify({ reviewProvider: 'claude' }),
    });

    expect(response.status).toBe(200);
  });

  test('serves the built UI from the static directory', async () => {
    const staticDir = join(dir, 'dist');
    await mkdir(staticDir);
    await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>PR Quest</title>');
    const server = await start({}, { staticDir });

    const response = await fetch(`${server.url}/quests`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>PR Quest</title>');
  });

  test('warns and serves only the API when the static directory has no build', async () => {
    const server = await start({}, { staticDir: join(dir, 'missing') });

    expect((await fetch(`${server.url}/`)).status).toBe(404);
    expect(logs.join('\n')).toMatch(/No UI build/);
  });

  test('keeps the secrets in an injected store instead of secrets.json', async () => {
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
    const server = await start({}, { secrets });

    await fetch(`${server.url}/api/settings/keys/anthropic`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'sk-ant-api03-INJECTED-0000' }),
    });

    expect(saved.get('anthropic')).toBe('sk-ant-api03-INJECTED-0000');
    await expect(stat(join(dir, 'state', 'secrets.json'))).rejects.toThrow(/ENOENT/);
  });

  test('refuses hosted mode without a hosted identity and storage', async () => {
    await expect(
      start({
        mode: 'hosted',
        host: '127.0.0.1',
        publicOrigin: 'https://pr-quest.example',
        allowedHosts: ['pr-quest.example'],
      }),
    ).rejects.toThrow(/hosted mode needs/i);
  });

  test('stops listening when closed', async () => {
    const server = await start();

    await server.close();
    running = undefined;

    await expect(fetch(`${server.url}/api/health`)).rejects.toThrow();
  });
});
