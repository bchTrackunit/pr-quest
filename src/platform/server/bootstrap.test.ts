import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';

import { BOOTSTRAP_PATH, BOOTSTRAP_TTL_MS, bootstrapRoute } from './bootstrap.ts';
import { createRouter, REQUEST_SECRET_COOKIE, type RawRoute } from './router.ts';

const SECRET = 's'.repeat(43);
const CODE = 'c'.repeat(43);

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

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

async function serve(route: RawRoute): Promise<number> {
  server = createServer(createRouter({}, { requestSecret: SECRET, routes: [route] }));
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) {
    throw new Error('Test server is not listening on a TCP port');
  }
  return address.port;
}

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<RawResponse>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

const open = (port: number, code = CODE, headers: Record<string, string> = {}) =>
  get(port, `${BOOTSTRAP_PATH}?code=${encodeURIComponent(code)}`, headers);

describe('bootstrap route', () => {
  test('sets the request secret cookie and sends the window to the UI', async () => {
    const port = await serve(bootstrapRoute({ code: CODE, requestSecret: SECRET }));

    const response = await open(port);

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/');
    expect(response.headers['set-cookie']).toEqual([
      `${REQUEST_SECRET_COOKIE}=${SECRET}; Path=/; HttpOnly; SameSite=Strict`,
    ]);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  test('the cookie it sets passes the request secret check', async () => {
    const port = await serve(bootstrapRoute({ code: CODE, requestSecret: SECRET }));
    const cookie = (await open(port)).headers['set-cookie']?.[0]?.split(';', 1)[0] ?? '';

    expect((await get(port, '/api/player')).status).toBe(403);
    // No handler for getPlayer, so a request that got past the check is answered 501.
    expect((await get(port, '/api/player', { Cookie: cookie })).status).toBe(501);
  });

  test('works only once', async () => {
    const port = await serve(bootstrapRoute({ code: CODE, requestSecret: SECRET }));

    expect((await open(port)).status).toBe(303);
    const again = await open(port);

    expect(again.status).toBe(403);
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  test('expires', async () => {
    let now = 1000;
    const port = await serve(bootstrapRoute({ code: CODE, requestSecret: SECRET, now: () => now }));
    now += BOOTSTRAP_TTL_MS + 1;

    expect((await open(port)).status).toBe(403);
  });

  test('refuses a wrong, partial or missing code without using up the real one', async () => {
    const port = await serve(bootstrapRoute({ code: CODE, requestSecret: SECRET }));

    const wrong = await open(port, 'x'.repeat(43));
    const partial = await open(port, CODE.slice(0, 20));
    const missing = await get(port, BOOTSTRAP_PATH);

    expect([wrong.status, partial.status, missing.status]).toEqual([403, 403, 403]);
    expect(wrong.text).not.toContain(CODE);
    expect((await open(port)).status).toBe(303);
  });

  test('keeps the router checks: a cross-site page or a rebound Host is refused', async () => {
    const port = await serve(bootstrapRoute({ code: CODE, requestSecret: SECRET }));

    expect((await open(port, CODE, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await open(port, CODE, { Host: 'rebind.example' })).status).toBe(403);
    // Neither attempt used the code up.
    expect((await open(port, CODE, { 'Sec-Fetch-Site': 'none' })).status).toBe(303);
  });

  test('refuses codes and secrets too short to be secret, or that a cookie cannot carry', () => {
    expect(() => bootstrapRoute({ code: 'short', requestSecret: SECRET })).toThrow(/code/);
    expect(() => bootstrapRoute({ code: CODE, requestSecret: 'short' })).toThrow(/secret/);
    expect(() => bootstrapRoute({ code: CODE, requestSecret: `${SECRET}; Path=/x` })).toThrow(
      /secret/,
    );
  });
});

describe('raw routes that skip the request secret', () => {
  const route: RawRoute = {
    method: 'GET',
    path: '/open',
    skipsRequestSecret: true,
    handle: (_req, res) => {
      res.end('open');
    },
  };

  test('are answered without the cookie', async () => {
    const port = await serve(route);

    expect((await get(port, '/open')).text).toBe('open');
  });

  test('must be a GET that is not cross-site', () => {
    expect(() => createRouter({}, { routes: [{ ...route, method: 'POST' }] })).toThrow(/GET/);
    expect(() => createRouter({}, { routes: [{ ...route, crossSite: true }] })).toThrow(
      /cross-site/,
    );
  });
});
