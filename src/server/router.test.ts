import { createServer, request, type Server } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';

import { createHandlers } from './handlers.ts';
import { createRouter, matchRoute, type RouteHandlers } from './router.ts';

interface TestResponse {
  status: number;
  body: unknown;
}

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
  server = undefined;
});

async function startServer(handlers: RouteHandlers): Promise<number> {
  server = createServer(createRouter(handlers));
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) {
    throw new Error('Test server is not listening on a TCP port');
  }
  return address.port;
}

function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const config = {
  host: '127.0.0.1',
  port: 0,
  uiPort: 0,
  stateDir: '/tmp/pr-quest-test',
  cursorApiKey: 'secret',
} as const;

describe('router', () => {
  test('GET /api/health reports which keys are configured without leaking them', async () => {
    const port = await startServer(createHandlers(config));

    const response = await send(port, 'GET', '/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      config: { linearApiKey: false, cursorApiKey: true },
    });
  });

  test('contract routes without a handler respond 501', async () => {
    const port = await startServer({});

    const response = await send(port, 'POST', '/api/quests/Trackunit%2Fmanager%231/review');

    expect(response.status).toBe(501);
    expect(response.body).toEqual({
      error: { code: 'notImplemented', message: 'Route "startReview" is not implemented yet' },
    });
  });

  test('unknown paths respond 404', async () => {
    const port = await startServer({});

    const response = await send(port, 'GET', '/api/nope');

    expect(response.status).toBe(404);
  });

  test('rejects cross-origin requests', async () => {
    const port = await startServer(createHandlers(config));

    const response = await send(port, 'POST', '/api/quests/x/approve', {
      Origin: 'https://evil.example',
    });

    expect(response.status).toBe(403);
  });

  test('rejects non-loopback Host headers', async () => {
    const port = await startServer(createHandlers(config));

    const response = await send(port, 'GET', '/api/health', { Host: 'rebind.example' });

    expect(response.status).toBe(403);
  });
});

describe('matchRoute', () => {
  test('decodes path parameters', () => {
    expect(matchRoute('GET', '/api/runs/run%2F1')).toEqual({
      name: 'getRun',
      params: { id: 'run/1' },
    });
  });

  test('does not match a different method', () => {
    expect(matchRoute('POST', '/api/runs')).toBeUndefined();
  });
});
