import { createServer, request, type Server } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createHandlers } from './handlers.ts';
import {
  ApiError,
  createRouter,
  loopbackOrigins,
  matchRoute,
  type RouteHandlers,
  type RouterOptions,
} from './router.ts';

interface TestResponse {
  status: number;
  body: unknown;
}

const API_PORT = 4317;
const UI_PORT = 4318;
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const START_REVIEW = '/api/quests/Trackunit%2Fmanager%231/review';

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

async function startServer(
  handlers: RouteHandlers,
  options: RouterOptions = { allowedOrigins: loopbackOrigins([API_PORT, UI_PORT]) },
): Promise<number> {
  server = createServer(createRouter(handlers, options));
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
  body?: string,
): Promise<TestResponse> {
  const framed =
    body === undefined
      ? headers
      : { ...headers, 'Content-Length': String(Buffer.byteLength(body)) };
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: framed }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
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
      config: { linearApiKey: false, cursorApiKey: true, anthropicApiKey: false },
    });
  });

  test('contract routes without a handler respond 501', async () => {
    const port = await startServer({});

    const response = await send(port, 'POST', START_REVIEW, JSON_HEADERS);

    expect(response.status).toBe(501);
    expect(response.body).toEqual({
      error: { code: 'notImplemented', message: 'Route "startReview" is not implemented yet' },
    });
  });

  test('names the provider whose configuration is missing', async () => {
    const port = await startServer({
      startReview: () => {
        throw new ApiError(400, 'missingConfig', 'Add an Anthropic API key', { provider: 'claude' });
      },
    });

    const response = await send(port, 'POST', START_REVIEW, JSON_HEADERS);

    expect(response).toEqual({
      status: 400,
      body: {
        error: { code: 'missingConfig', message: 'Add an Anthropic API key', provider: 'claude' },
      },
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

  test.each(['http://127.0.0.1:9999', 'http://localhost:6006', 'http://127.0.0.1', 'null'])(
    'rejects a POST from the other origin %s',
    async (origin) => {
      const port = await startServer({});

      const response = await send(port, 'POST', START_REVIEW, { ...JSON_HEADERS, Origin: origin });

      expect(response).toEqual({
        status: 403,
        body: { error: { code: 'forbidden', message: 'Cross-origin requests are not allowed' } },
      });
    },
  );

  test.each([
    `http://127.0.0.1:${UI_PORT}`,
    `http://localhost:${UI_PORT}`,
    `http://127.0.0.1:${API_PORT}`,
    `http://localhost:${API_PORT}`,
  ])('accepts a POST from the configured origin %s', async (origin) => {
    const port = await startServer({});

    const response = await send(port, 'POST', START_REVIEW, { ...JSON_HEADERS, Origin: origin });

    expect(response.status).toBe(501);
  });

  test('rejects any Origin when no origins are configured', async () => {
    const port = await startServer({}, {});

    const response = await send(port, 'POST', START_REVIEW, {
      ...JSON_HEADERS,
      Origin: `http://127.0.0.1:${UI_PORT}`,
    });

    expect(response.status).toBe(403);
  });

  test.each(['same-site', 'cross-site'])('rejects a POST with Sec-Fetch-Site: %s', async (site) => {
    const port = await startServer({});

    const response = await send(port, 'POST', START_REVIEW, {
      ...JSON_HEADERS,
      'Sec-Fetch-Site': site,
    });

    expect(response).toEqual({
      status: 403,
      body: { error: { code: 'forbidden', message: 'Cross-site requests are not allowed' } },
    });
  });

  test.each(['same-origin', 'none'])('accepts a POST with Sec-Fetch-Site: %s', async (site) => {
    const port = await startServer({});

    const response = await send(port, 'POST', START_REVIEW, {
      ...JSON_HEADERS,
      'Sec-Fetch-Site': site,
    });

    expect(response.status).toBe(501);
  });

  test.each(['same-site', 'cross-site'])(
    'rejects a GET with Sec-Fetch-Site: %s before any handler runs',
    async (site) => {
      const health = vi.fn(() => ({
        ok: true as const,
        config: { linearApiKey: false, cursorApiKey: false, anthropicApiKey: false },
      }));
      const port = await startServer({ health });

      const response = await send(port, 'GET', '/api/health', { 'Sec-Fetch-Site': site });

      expect(response).toEqual({
        status: 403,
        body: { error: { code: 'forbidden', message: 'Cross-site requests are not allowed' } },
      });
      expect(health).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['Sec-Fetch-Site: same-origin', { 'Sec-Fetch-Site': 'same-origin' }],
    ['Sec-Fetch-Site: none', { 'Sec-Fetch-Site': 'none' }],
    ['no Sec-Fetch-Site', {}],
  ])('accepts a GET with %s', async (_label, headers) => {
    const port = await startServer(createHandlers(config));

    const response = await send(port, 'GET', '/api/health', headers);

    expect(response.status).toBe(200);
  });

  test('rejects a GET from Origin: null', async () => {
    const port = await startServer(createHandlers(config));

    const response = await send(port, 'GET', '/api/health', { Origin: 'null' });

    expect(response.status).toBe(403);
  });

  test.each([
    ['text/plain', { 'Content-Type': 'text/plain' }],
    ['form data', { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['no content type', {}],
  ])('rejects a POST sent as %s with 415', async (_label, headers) => {
    const port = await startServer({});

    const response = await send(port, 'POST', START_REVIEW, headers, '{"confirm":true}');

    expect(response).toEqual({
      status: 415,
      body: { error: { code: 'badRequest', message: 'POST bodies must be application/json' } },
    });
  });

  test.each([
    ['PUT', '/api/settings'],
    ['DELETE', '/api/settings/keys/cursor'],
  ])('rejects a %s that is not JSON with 415', async (method, path) => {
    const port = await startServer({});

    const response = await send(port, method, path, { 'Content-Type': 'text/plain' }, '{}');

    expect(response).toEqual({
      status: 415,
      body: { error: { code: 'badRequest', message: `${method} bodies must be application/json` } },
    });
  });

  test.each(['PUT', 'DELETE'])('rejects a cross-site %s', async (method) => {
    const port = await startServer({});

    const response = await send(port, method, '/api/settings/keys/cursor', {
      ...JSON_HEADERS,
      'Sec-Fetch-Site': 'same-site',
    });

    expect(response.status).toBe(403);
  });

  test('routes PUT and DELETE to their handlers', async () => {
    const port = await startServer({});

    const put = await send(port, 'PUT', '/api/settings', JSON_HEADERS, '{}');
    const del = await send(port, 'DELETE', '/api/settings/keys/cursor', JSON_HEADERS);

    expect(put.body).toMatchObject({
      error: { message: 'Route "updateSettings" is not implemented yet' },
    });
    expect(del.body).toMatchObject({
      error: { message: 'Route "removeApiKey" is not implemented yet' },
    });
  });

  test('accepts application/json with a charset', async () => {
    const port = await startServer({});

    const response = await send(
      port,
      'POST',
      START_REVIEW,
      { 'Content-Type': 'Application/JSON; charset=utf-8' },
      '{}',
    );

    expect(response.status).toBe(501);
  });
});

describe('loopbackOrigins', () => {
  test('lists the 127.0.0.1 and localhost origin of every port', () => {
    expect(loopbackOrigins([4317, 4318])).toEqual([
      'http://127.0.0.1:4317',
      'http://localhost:4317',
      'http://127.0.0.1:4318',
      'http://localhost:4318',
    ]);
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
