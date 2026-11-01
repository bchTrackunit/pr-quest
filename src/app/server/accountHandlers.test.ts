import { createServer, request, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { DeviceFlowStatus, ListModelsResponse } from '../../shared/api.ts';
import { createAccountHandlers, type AccountServices } from './accountHandlers.ts';
import {
  ApiKeys,
  type AppSettings,
  type SettingsPatch,
} from '../../features/settings/server/index.ts';
import { createRouter, loopbackOrigins } from '../../platform/server/router.ts';
import type { SecretName } from '../../platform/server/secrets.ts';

const SAVED_KEY = 'sk-ant-api03-SAVEDSECRETVALUE-wxyz';
const NEW_KEY = 'crsr_NEWSECRETVALUE_0123456789';
const ENV_KEY = 'lin_api_ENVSECRETVALUE_abcd';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

interface TestResponse {
  status: number;
  body: unknown;
  text: string;
}

let server: Server | undefined;
let port: number;
let secrets: Map<SecretName, string>;
let settings: AppSettings;
/** Always with a device flow, which the tests that go without it drop. */
type FakeServices = AccountServices & { deviceFlow: NonNullable<AccountServices['deviceFlow']> };

let services: FakeServices;
let device: DeviceFlowStatus;

function fakeServices(): FakeServices {
  const apiKeys = new ApiKeys({
    env: { linear: ENV_KEY },
    secrets: {
      get: (name) => secrets.get(name),
      set: async (name, value) => void secrets.set(name, value),
      delete: async (name) => void secrets.delete(name),
    },
  });
  device = {
    state: 'pending',
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    expiresAt: '2026-10-31T09:00:00.000Z',
  };
  return {
    apiKeys,
    settings: {
      get: () => settings,
      update: vi.fn(async (patch: SettingsPatch) => {
        const models = { ...settings.models };
        for (const [provider, model] of Object.entries(patch.models ?? {})) {
          if (provider === 'cursor' || provider === 'claude') {
            if (model) {
              models[provider] = model;
            } else {
              delete models[provider];
            }
          }
        }
        const timeZone = patch.timeZone === undefined ? settings.timeZone : patch.timeZone;
        settings = { reviewProvider: patch.reviewProvider ?? settings.reviewProvider, models };
        if (timeZone) {
          settings.timeZone = timeZone;
        }
        return settings;
      }),
    },
    models: {
      list: vi.fn(async (provider): Promise<ListModelsResponse> => ({
        provider,
        source: 'api',
        models: [{ id: 'm', displayName: 'M' }],
      })),
    },
    deviceFlow: {
      start: vi.fn(async () => device),
      status: () => device,
      cancel: vi.fn(),
      acknowledgeComplete: vi.fn(() => {
        if (device.state === 'complete') {
          device = { state: 'idle' };
        }
      }),
      isConfigured: () => true,
    },
    auth: {
      current: async () => ({ account: { login: 'Player', tokenSource: 'oauth' } }),
      signOut: vi.fn(async (): Promise<{ signedOutLogin?: string }> => ({})),
    },
  };
}

beforeEach(async () => {
  secrets = new Map([['anthropic', SAVED_KEY]]);
  settings = { reviewProvider: 'cursor', models: {} };
  services = fakeServices();
  await listen(services);
});

async function listen(served: AccountServices): Promise<void> {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = createServer(
    createRouter(createAccountHandlers(served), {
      allowedOrigins: loopbackOrigins([4317, 4318]),
    }),
  );
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) {
    throw new Error('Test server is not listening on a TCP port');
  }
  port = address.port;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

function send(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<TestResponse> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers = {
    ...(options.headers ?? (method === 'GET' ? {} : JSON_HEADERS)),
    ...(body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(body)) }),
  };
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text), text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const expectNoSecrets = (response: TestResponse): void => {
  for (const secret of [SAVED_KEY, NEW_KEY, ENV_KEY]) {
    expect(response.text).not.toContain(secret);
  }
};

describe('settings', () => {
  test('GET /api/settings reports keys as set, source and last4 only', async () => {
    const response = await send('GET', '/api/settings');

    expect(response).toMatchObject({
      status: 200,
      body: {
        reviewProvider: 'cursor',
        models: {},
        keys: {
          cursor: { set: false },
          anthropic: { set: true, source: 'settings', last4: 'wxyz' },
          linear: { set: true, source: 'env', last4: 'abcd' },
        },
      },
    });
    expectNoSecrets(response);
  });

  test('PUT /api/settings saves the provider and models; null goes back to the default', async () => {
    settings = { reviewProvider: 'cursor', models: { cursor: 'composer-2' } };

    const response = await send('PUT', '/api/settings', {
      body: { reviewProvider: 'claude', models: { claude: 'claude-opus-5-5', cursor: null } },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      reviewProvider: 'claude',
      models: { claude: 'claude-opus-5-5' },
    });
    expect(services.settings.update).toHaveBeenCalledWith({
      reviewProvider: 'claude',
      models: { claude: 'claude-opus-5-5', cursor: null },
    });
  });

  test('PUT /api/settings saves an IANA time zone under its canonical name', async () => {
    const response = await send('PUT', '/api/settings', {
      body: { timeZone: 'europe/copenhagen' },
    });

    expect(response).toMatchObject({ status: 200, body: { timeZone: 'Europe/Copenhagen' } });
    expect(services.settings.update).toHaveBeenCalledWith({ timeZone: 'Europe/Copenhagen' });
  });

  test('PUT /api/settings clears the time zone with null', async () => {
    settings = { reviewProvider: 'cursor', models: {}, timeZone: 'Asia/Tokyo' };

    const response = await send('PUT', '/api/settings', { body: { timeZone: null } });

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('timeZone');
    expect(services.settings.update).toHaveBeenCalledWith({ timeZone: null });
  });

  test.each([
    ['an unknown time zone', { timeZone: 'Mars/Olympus_Mons' }],
    ['a fixed UTC offset', { timeZone: '+02:00' }],
    ['a non-string time zone', { timeZone: 1 }],
    ['an unknown provider', { reviewProvider: 'openai' }],
    ['an unknown field', { reviewProvider: 'claude', theme: 'dark' }],
    ['a model for an unknown provider', { models: { openai: 'gpt' } }],
    ['a model id with spaces', { models: { claude: 'claude opus' } }],
    ['an over-long model id', { models: { claude: 'x'.repeat(201) } }],
    ['a non-object body', ['claude']],
    ['no body', undefined],
  ])('PUT /api/settings rejects %s', async (_case, body) => {
    const response = await send('PUT', '/api/settings', { body });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'badRequest' } });
    expect(services.settings.update).not.toHaveBeenCalled();
  });
});

describe('API keys', () => {
  test('PUT /api/settings/keys/:name saves the key and never echoes it', async () => {
    const response = await send('PUT', '/api/settings/keys/cursor', { body: { value: NEW_KEY } });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      keys: { cursor: { set: true, source: 'settings', last4: '6789' } },
    });
    expect(secrets.get('cursor')).toBe(NEW_KEY);
    expectNoSecrets(response);
  });

  test.each([
    ['an unknown key name', '/api/settings/keys/github', { value: NEW_KEY }],
    ['a missing value', '/api/settings/keys/cursor', {}],
    ['a non-string value', '/api/settings/keys/cursor', { value: 42 }],
    ['an extra field', '/api/settings/keys/cursor', { value: NEW_KEY, echo: true }],
    ['a value with spaces', '/api/settings/keys/cursor', { value: `${NEW_KEY} x` }],
    ['an over-long value', '/api/settings/keys/cursor', { value: 'k'.repeat(1001) }],
  ])('rejects %s without repeating the value', async (_case, path, body) => {
    const response = await send('PUT', path, { body });

    expect(response.status).toBe(400);
    expect(secrets.has('cursor')).toBe(false);
    expectNoSecrets(response);
  });

  test('refuses to change a key that comes from the environment', async () => {
    const response = await send('PUT', '/api/settings/keys/linear', { body: { value: NEW_KEY } });

    expect(response.status).toBe(409);
    expectNoSecrets(response);
  });

  test('DELETE /api/settings/keys/:name forgets a saved key', async () => {
    const response = await send('DELETE', '/api/settings/keys/anthropic');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ keys: { anthropic: { set: false } } });
    expect(secrets.has('anthropic')).toBe(false);
  });

  test('DELETE rejects an unknown key name', async () => {
    expect((await send('DELETE', '/api/settings/keys/github')).status).toBe(400);
  });
});

describe('models', () => {
  test('GET /api/settings/models lists the chosen provider', async () => {
    const response = await send('GET', '/api/settings/models?provider=claude');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ provider: 'claude', source: 'api' });
    expect(services.models.list).toHaveBeenCalledWith('claude');
  });

  test.each(['', '?provider=openai', '?provider='])('rejects the query %j', async (query) => {
    const response = await send('GET', `/api/settings/models${query}`);

    expect(response.status).toBe(400);
    expect(services.models.list).not.toHaveBeenCalled();
  });
});

describe('auth without a device flow', () => {
  beforeEach(async () => {
    await listen({ ...services, deviceFlow: undefined });
  });

  test('reports sign-in as unconfigured and idle', async () => {
    const response = await send('GET', '/api/auth/status');

    expect(response.body).toEqual({
      clientIdConfigured: false,
      account: { login: 'Player', tokenSource: 'oauth' },
      device: { state: 'idle' },
    });
  });

  test('refuses to start the device flow', async () => {
    const response = await send('POST', '/api/auth/device');

    expect(response).toMatchObject({ status: 409, body: { error: { code: 'missingConfig' } } });
  });

  test('still signs out', async () => {
    const response = await send('POST', '/api/auth/sign-out');

    expect(response.status).toBe(200);
    expect(services.auth.signOut).toHaveBeenCalledOnce();
  });
});

describe('auth', () => {
  test('GET /api/auth/status reports the account and sign-in state', async () => {
    const response = await send('GET', '/api/auth/status');

    expect(response.body).toEqual({
      clientIdConfigured: true,
      account: { login: 'Player', tokenSource: 'oauth' },
      device: expect.objectContaining({ state: 'pending', userCode: 'ABCD-1234' }),
    });
  });

  test('reports a finished sign-in once with the account, then goes back to idle', async () => {
    device = { state: 'complete' };

    const first = await send('GET', '/api/auth/status');
    const second = await send('GET', '/api/auth/status');

    expect(first.body).toMatchObject({
      account: { login: 'Player' },
      device: { state: 'complete' },
    });
    expect(second.body).toMatchObject({ account: { login: 'Player' }, device: { state: 'idle' } });
  });

  test('keeps reporting a finished sign-in while the account is not known yet', async () => {
    device = { state: 'complete' };
    services.auth.current = async () => ({ error: 'GitHub is down' });

    await send('GET', '/api/auth/status');

    expect(services.deviceFlow.acknowledgeComplete).not.toHaveBeenCalled();
  });

  test('POST /api/auth/device starts the sign-in', async () => {
    const response = await send('POST', '/api/auth/device');

    expect(response.body).toMatchObject({ device: { state: 'pending' } });
    expect(services.deviceFlow.start).toHaveBeenCalledOnce();
  });

  test('POST /api/auth/device rejects a body', async () => {
    const response = await send('POST', '/api/auth/device', { body: { scope: 'admin:org' } });

    expect(response.status).toBe(400);
    expect(services.deviceFlow.start).not.toHaveBeenCalled();
  });

  test('DELETE /api/auth/device cancels the sign-in', async () => {
    await send('DELETE', '/api/auth/device');

    expect(services.deviceFlow.cancel).toHaveBeenCalledOnce();
  });

  test('POST /api/auth/sign-out forgets the token and reports the new status', async () => {
    const response = await send('POST', '/api/auth/sign-out');

    expect(response.status).toBe(200);
    expect(services.auth.signOut).toHaveBeenCalledOnce();
    expect(response.body).toMatchObject({ clientIdConfigured: true });
    expect(response.body).not.toHaveProperty('fellBackFrom');
  });

  test('sign-out says when PR Quest now acts as a different gh account', async () => {
    vi.mocked(services.auth.signOut).mockResolvedValueOnce({ signedOutLogin: 'Other-Player' });
    services.auth.current = async () => ({ account: { login: 'Player', tokenSource: 'gh' } });

    const response = await send('POST', '/api/auth/sign-out');

    expect(response.body).toMatchObject({
      account: { login: 'Player', tokenSource: 'gh' },
      fellBackFrom: 'Other-Player',
    });
  });

  test.each([
    ['the same login through gh', { login: 'player', tokenSource: 'gh' } as const],
    ['no account at all', undefined],
  ])('sign-out reports no fallback for %s', async (_case, account) => {
    vi.mocked(services.auth.signOut).mockResolvedValueOnce({ signedOutLogin: 'Player' });
    services.auth.current = async () => (account ? { account } : {});

    const response = await send('POST', '/api/auth/sign-out');

    expect(response.body).not.toHaveProperty('fellBackFrom');
  });
});

describe('request checks on every settings, key and auth write', () => {
  const WRITES: Array<[string, string, unknown]> = [
    ['PUT', '/api/settings', { reviewProvider: 'claude' }],
    ['PUT', '/api/settings/keys/cursor', { value: NEW_KEY }],
    ['DELETE', '/api/settings/keys/anthropic', undefined],
    ['POST', '/api/auth/device', undefined],
    ['DELETE', '/api/auth/device', undefined],
    ['POST', '/api/auth/sign-out', undefined],
  ];

  const expectNothingChanged = (): void => {
    expect([...secrets]).toEqual([['anthropic', SAVED_KEY]]);
    expect(settings).toEqual({ reviewProvider: 'cursor', models: {} });
    expect(services.settings.update).not.toHaveBeenCalled();
    expect(services.deviceFlow.start).not.toHaveBeenCalled();
    expect(services.deviceFlow.cancel).not.toHaveBeenCalled();
    expect(services.auth.signOut).not.toHaveBeenCalled();
  };

  test.each(WRITES)('%s %s needs a JSON content type', async (method, path, body) => {
    const response = await send(method, path, { headers: { 'Content-Type': 'text/plain' }, body });

    expect(response.status).toBe(415);
    expectNothingChanged();
  });

  test.each(WRITES)(
    '%s %s refuses other origins and changes nothing',
    async (method, path, body) => {
      const response = await send(method, path, {
        headers: { ...JSON_HEADERS, Origin: 'http://127.0.0.1:9999' },
        body,
      });

      expect(response.status).toBe(403);
      expectNothingChanged();
    },
  );

  test.each(WRITES)(
    '%s %s refuses Origin: null and changes nothing',
    async (method, path, body) => {
      const response = await send(method, path, {
        headers: { ...JSON_HEADERS, Origin: 'null' },
        body,
      });

      expect(response.status).toBe(403);
      expectNothingChanged();
    },
  );

  test.each(WRITES)('%s %s refuses cross-site requests', async (method, path, body) => {
    const response = await send(method, path, {
      headers: { ...JSON_HEADERS, 'Sec-Fetch-Site': 'same-site' },
      body,
    });

    expect(response.status).toBe(403);
    expectNothingChanged();
  });

  test.each(['/api/settings', '/api/settings/models?provider=cursor', '/api/auth/status'])(
    'GET %s refuses other origins',
    async (path) => {
      const response = await send('GET', path, { headers: { Origin: 'https://evil.example' } });

      expect(response.status).toBe(403);
    },
  );

  test.each(['cross-site', 'same-site'])(
    'GET /api/settings/models refuses Sec-Fetch-Site: %s without asking the provider',
    async (site) => {
      const response = await send('GET', '/api/settings/models?provider=claude', {
        headers: { 'Sec-Fetch-Site': site },
      });

      expect(response.status).toBe(403);
      expect(services.models.list).not.toHaveBeenCalled();
    },
  );
});
