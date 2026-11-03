import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// oxlint-disable-next-line local/feature-boundaries -- exercises the router with the app's real route table
import { createHandlers } from '../app/handlers.ts';
import {
  ApiError,
  createRouter,
  loopbackOrigins,
  matchRoute,
  type RawRoute,
  type RouteHandlers,
  type RouterOptions,
  trustedRequests,
} from './router.ts';
import { HOSTED_CONFIG, LOCAL_CONFIG } from './test-utils/config.ts';

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

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

function sendRaw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<RawResponse> {
  const framed =
    body === undefined
      ? headers
      : { ...headers, 'Content-Length': String(Buffer.byteLength(body)) };
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: framed }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<TestResponse> {
  const { status, text } = await sendRaw(port, method, path, headers, body);
  return { status, body: JSON.parse(text) };
}

const config = { ...LOCAL_CONFIG, cursorApiKey: 'secret' };

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

  test('tells browsers not to sniff JSON responses as another type', async () => {
    const port = await startServer(createHandlers(config));

    const ok = await sendRaw(port, 'GET', '/api/health');
    const missing = await sendRaw(port, 'GET', '/api/nothing');

    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(missing.headers['x-content-type-options']).toBe('nosniff');
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
        throw new ApiError(400, 'missingConfig', 'Add an Anthropic API key', {
          provider: 'claude',
        });
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

describe('trustedRequests', () => {
  const HOSTED = HOSTED_CONFIG;
  const PUBLIC = { Host: 'pr-quest.example', Origin: 'https://pr-quest.example' };

  describe('in local mode', () => {
    test('trusts loopback hosts and only the origin it serves', () => {
      expect(trustedRequests({ ...LOCAL_CONFIG, uiPort: UI_PORT }, API_PORT)).toEqual({
        allowedHosts: ['127.0.0.1', 'localhost'],
        allowedOrigins: loopbackOrigins([API_PORT]),
        hostCheckExempt: [],
      });
    });

    test('also trusts the UI dev server, which proxies /api, when asked', () => {
      expect(
        trustedRequests({ ...LOCAL_CONFIG, uiPort: UI_PORT }, API_PORT, { devUiOrigin: true }),
      ).toMatchObject({ allowedOrigins: loopbackOrigins([API_PORT, UI_PORT]) });
    });

    test('still checks the Host of /api/health', async () => {
      const port = await startServer(
        createHandlers(config),
        trustedRequests({ ...LOCAL_CONFIG, uiPort: UI_PORT }, API_PORT),
      );

      const response = await send(port, 'GET', '/api/health', { Host: 'rebind.example' });

      expect(response).toEqual({
        status: 403,
        body: { error: { code: 'forbidden', message: 'Host must be 127.0.0.1 or localhost' } },
      });
    });
  });

  describe('in hosted mode', () => {
    test('trusts the allowed hosts and only the public origin', () => {
      expect(trustedRequests(HOSTED, 8080)).toEqual({
        allowedHosts: ['pr-quest.example', 'pr-quest.fly.dev'],
        allowedOrigins: ['https://pr-quest.example'],
        hostCheckExempt: ['health'],
      });
    });

    test.each(['pr-quest.example', 'PR-Quest.example:443', 'pr-quest.fly.dev'])(
      'accepts the Host %s',
      async (host) => {
        const port = await startServer({}, trustedRequests(HOSTED, 8080));

        const response = await send(port, 'POST', START_REVIEW, { ...JSON_HEADERS, Host: host });

        expect(response.status).toBe(501);
      },
    );

    test.each(['127.0.0.1', 'localhost', 'evil.example'])(
      'rejects the Host %s on API routes',
      async (host) => {
        const port = await startServer({}, trustedRequests(HOSTED, 8080));

        const response = await send(port, 'POST', START_REVIEW, { ...JSON_HEADERS, Host: host });

        expect(response).toEqual({
          status: 403,
          body: {
            error: {
              code: 'forbidden',
              message: 'Host must be pr-quest.example or pr-quest.fly.dev',
            },
          },
        });
      },
    );

    test('accepts a POST from the public origin', async () => {
      const port = await startServer({}, trustedRequests(HOSTED, 8080));

      const response = await send(port, 'POST', START_REVIEW, { ...JSON_HEADERS, ...PUBLIC });

      expect(response.status).toBe(501);
    });

    test.each(['http://pr-quest.example', 'http://127.0.0.1:8080', 'https://evil.example'])(
      'rejects a POST from the origin %s',
      async (origin) => {
        const port = await startServer({}, trustedRequests(HOSTED, 8080));

        const response = await send(port, 'POST', START_REVIEW, {
          ...JSON_HEADERS,
          ...PUBLIC,
          Origin: origin,
        });

        expect(response.status).toBe(403);
      },
    );

    test('answers /api/health whatever the Host, for load balancer health checks', async () => {
      const port = await startServer(createHandlers(config), trustedRequests(HOSTED, 8080));

      const response = await send(port, 'GET', '/api/health', { Host: '10.0.0.7:8080' });

      expect(response.status).toBe(200);
    });

    test('still rejects a cross-site /api/health', async () => {
      const port = await startServer(createHandlers(config), trustedRequests(HOSTED, 8080));

      const response = await send(port, 'GET', '/api/health', {
        Host: '10.0.0.7:8080',
        'Sec-Fetch-Site': 'cross-site',
      });

      expect(response.status).toBe(403);
    });
  });
});

describe('static files', () => {
  let staticDir: string;
  const INDEX = '<!doctype html><title>PR Quest</title>';

  beforeEach(async () => {
    const parent = await mkdtemp(join(tmpdir(), 'pr-quest-static-'));
    staticDir = join(parent, 'dist');
    await mkdir(join(staticDir, 'assets'), { recursive: true });
    await writeFile(join(staticDir, 'index.html'), INDEX);
    await writeFile(join(staticDir, 'favicon.svg'), '<svg/>');
    await writeFile(join(staticDir, '.env'), 'SECRET=1');
    await writeFile(join(staticDir, 'assets', 'index-B4x9kQ.js'), 'console.log(1);');
    await writeFile(join(parent, 'secret.txt'), 'outside the static directory');
  });

  afterEach(async () => {
    await rm(join(staticDir, '..'), { recursive: true, force: true });
  });

  const serve = (options: RouterOptions = {}) =>
    startServer({ health: createHandlers(config).health }, { ...options, staticDir });

  test('serves index.html at / without letting the browser reuse it unchecked', async () => {
    const port = await serve();

    const response = await sendRaw(port, 'GET', '/');

    expect(response).toMatchObject({
      status: 200,
      text: INDEX,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      },
    });
  });

  test.each(['/quests', '/runs/run-1', '/index.html'])('serves index.html for %s', async (path) => {
    const port = await serve();

    const response = await sendRaw(port, 'GET', path);

    expect(response).toMatchObject({ status: 200, text: INDEX });
  });

  test('caches hashed assets for good', async () => {
    const port = await serve();

    const response = await sendRaw(port, 'GET', '/assets/index-B4x9kQ.js');

    expect(response).toMatchObject({
      status: 200,
      text: 'console.log(1);',
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  });

  test('revalidates files outside assets/, whose names carry no hash', async () => {
    const port = await serve();

    const response = await sendRaw(port, 'GET', '/favicon.svg');

    expect(response.headers).toMatchObject({
      'content-type': 'image/svg+xml',
      'cache-control': 'no-cache',
    });
  });

  test.each(['/assets/index-gone.js', '/missing.png'])(
    'answers 404 for the missing file %s instead of index.html',
    async (path) => {
      const port = await serve();

      const response = await sendRaw(port, 'GET', path);

      expect(response.status).toBe(404);
      expect(response.text).not.toContain(INDEX);
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  test.each(['/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/.env', '/%2e%2e/secret.txt'])(
    'never serves %s',
    async (path) => {
      const port = await serve();

      const response = await sendRaw(port, 'GET', path);

      expect(response.status).toBe(404);
      expect(response.text).not.toContain('outside the static directory');
      expect(response.text).not.toContain('SECRET');
    },
  );

  test.each(['/leak.txt', '/up/secret.txt'])(
    'never follows a symlink out of the static directory for %s',
    async (path) => {
      const parent = join(staticDir, '..');
      await symlink(join(parent, 'secret.txt'), join(staticDir, 'leak.txt'));
      await symlink(parent, join(staticDir, 'up'));
      const port = await serve();

      const response = await sendRaw(port, 'GET', path);

      expect(response.status).toBe(404);
      expect(response.text).not.toContain('outside the static directory');
    },
  );

  test('serves a symlink that stays inside the static directory', async () => {
    await symlink(join(staticDir, 'favicon.svg'), join(staticDir, 'icon.svg'));
    const port = await serve();

    expect((await sendRaw(port, 'GET', '/icon.svg')).text).toBe('<svg/>');
  });

  test('answers 404, not a server error, for a name too long for the file system', async () => {
    const onUnexpectedError = vi.fn();
    const port = await serve({ onUnexpectedError });

    const response = await sendRaw(port, 'GET', `/${'a'.repeat(300)}.js`);

    expect(response.status).toBe(404);
    expect(onUnexpectedError).not.toHaveBeenCalled();
  });

  test('answers 404 for a file in a directory it may not read', async () => {
    const locked = join(staticDir, 'locked');
    await mkdir(locked);
    await writeFile(join(locked, 'file.js'), 'locked');
    await chmod(locked, 0o000);
    const onUnexpectedError = vi.fn();
    const port = await serve({ onUnexpectedError });

    const response = await sendRaw(port, 'GET', '/locked/file.js');
    await chmod(locked, 0o700);

    expect(response.status).toBe(404);
    expect(onUnexpectedError).not.toHaveBeenCalled();
  });

  test('answers HEAD with the headers only', async () => {
    const port = await serve();

    const response = await sendRaw(port, 'HEAD', '/');

    expect(response).toMatchObject({
      status: 200,
      text: '',
      headers: { 'content-length': String(INDEX.length) },
    });
  });

  test('opens from a link on another site, which browsers send as cross-site', async () => {
    const port = await serve();

    const response = await sendRaw(port, 'GET', '/', { 'Sec-Fetch-Site': 'cross-site' });

    expect(response.status).toBe(200);
  });

  test('still checks the Host, so a rebound name gets nothing', async () => {
    const port = await serve();

    const response = await sendRaw(port, 'GET', '/', { Host: 'rebind.example' });

    expect(response.status).toBe(403);
  });

  test('leaves /api to the routes', async () => {
    const port = await serve();

    expect((await send(port, 'GET', '/api/nope')).status).toBe(404);
    expect((await send(port, 'GET', '/api/health')).status).toBe(200);
  });

  test('serves no files to other methods', async () => {
    const port = await serve();

    const response = await send(port, 'POST', '/', JSON_HEADERS, '{}');

    expect(response.status).toBe(404);
  });

  test('without a static directory, / is not found as before', async () => {
    const port = await startServer({});

    expect((await send(port, 'GET', '/')).status).toBe(404);
  });
});

describe('raw routes', () => {
  const redirect = (location: string): RawRoute['handle'] => {
    return (_req, res) => {
      res.writeHead(302, { Location: location }).end();
    };
  };
  const signIn: RawRoute = {
    method: 'GET',
    path: '/auth/github',
    handle: redirect('https://github.com/login/oauth/authorize'),
  };
  const callback: RawRoute = {
    method: 'GET',
    path: '/auth/github/callback',
    crossSite: true,
    handle: redirect('/'),
  };
  const serve = (routes: ReadonlyArray<RawRoute>, options: RouterOptions = {}) =>
    startServer({}, { ...options, routes });

  test('lets the handler write a non-JSON response, such as a redirect', async () => {
    const port = await serve([signIn]);

    const response = await sendRaw(port, 'GET', '/auth/github?next=%2F');

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('https://github.com/login/oauth/authorize');
  });

  test('refuses a cross-site request unless the route expects one', async () => {
    const port = await serve([signIn, callback]);
    const crossSite = { 'Sec-Fetch-Site': 'cross-site' };

    expect((await sendRaw(port, 'GET', '/auth/github', crossSite)).status).toBe(403);
    expect((await sendRaw(port, 'GET', '/auth/github/callback?code=1', crossSite)).status).toBe(
      302,
    );
  });

  test('still checks the Host of a cross-site route', async () => {
    const port = await serve([callback]);

    const response = await sendRaw(port, 'GET', '/auth/github/callback', {
      Host: 'rebind.example',
      'Sec-Fetch-Site': 'cross-site',
    });

    expect(response.status).toBe(403);
  });

  test('answers before the built UI would', async () => {
    const staticDir = await mkdtemp(join(tmpdir(), 'pr-quest-raw-'));
    await writeFile(join(staticDir, 'index.html'), '<!doctype html>');
    const port = await serve([callback], { staticDir });

    const response = await sendRaw(port, 'GET', '/auth/github/callback');
    await rm(staticDir, { recursive: true, force: true });

    expect(response.status).toBe(302);
  });

  test('answers a thrown ApiError as JSON', async () => {
    const port = await serve([
      {
        ...signIn,
        handle: () => {
          throw new ApiError(400, 'badRequest', 'No OAuth state');
        },
      },
    ]);

    expect(await send(port, 'GET', '/auth/github')).toEqual({
      status: 400,
      body: { error: { code: 'badRequest', message: 'No OAuth state' } },
    });
  });

  test('refuses a raw route that would shadow the JSON API or another raw route', () => {
    expect(() => createRouter({}, { routes: [{ ...signIn, path: '/api/health' }] })).toThrow(
      /api\/health/,
    );
    expect(() => createRouter({}, { routes: [signIn, signIn] })).toThrow(/twice/);
    expect(() => createRouter({}, { routes: [{ ...signIn, path: 'auth' }] })).toThrow(/start/);
  });

  test('takes a POST only with an allowed Origin, which browsers send on every POST', async () => {
    const appOrigin = `http://127.0.0.1:${API_PORT}`;
    const signOut: RawRoute = {
      method: 'POST',
      path: '/auth/sign-out',
      handle: (_req, res) => {
        res.writeHead(204).end();
      },
    };
    const port = await serve([signOut], { allowedOrigins: [appOrigin] });
    const form = { 'Content-Type': 'application/x-www-form-urlencoded' };

    expect((await sendRaw(port, 'POST', '/auth/sign-out', form, 'a=1')).status).toBe(403);
    expect(
      (await sendRaw(port, 'POST', '/auth/sign-out', { ...form, Origin: 'http://evil.example' }))
        .status,
    ).toBe(403);
    expect((await sendRaw(port, 'POST', '/auth/sign-out', { Origin: appOrigin })).status).toBe(204);
  });

  test('refuses a cross-site POST route, which any site could submit a form to', () => {
    expect(() => createRouter({}, { routes: [{ ...callback, method: 'POST' }] })).toThrow(
      /POST \/auth\/github\/callback.*GET/,
    );
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
