import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { DeviceFlow, GITHUB_OAUTH_SCOPES, type TokenContext } from './deviceFlow.ts';

const CODE_RESPONSE = {
  device_code: 'dev-secret-code',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Replies to the code request, then to each token poll in order. */
function setup(pollReplies: Array<unknown>, clientId: string | null = 'Iv1.client') {
  let nowMs = Date.parse('2026-10-30T12:00:00.000Z');
  const sleeps: Array<number> = [];
  const polls: Array<unknown> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const body: unknown = JSON.parse(String(init?.body ?? '{}'));
    if (href === 'https://github.com/login/device/code') {
      return json(CODE_RESPONSE);
    }
    if (href === 'https://github.com/login/oauth/access_token') {
      polls.push(body);
      return json(pollReplies.shift() ?? { error: 'authorization_pending' });
    }
    throw new Error(`unexpected ${href}`);
  });
  const onToken = vi.fn(async (_token: string, _context?: TokenContext) => undefined);
  const flow = new DeviceFlow({
    clientId: clientId ?? undefined,
    fetch: fetchMock,
    onToken,
    log: () => undefined,
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  });
  return { flow, fetchMock, onToken, sleeps, polls };
}

describe('DeviceFlow', () => {
  test('is configured only with a client ID', () => {
    expect(setup([]).flow.isConfigured()).toBe(true);
    expect(setup([], null).flow.isConfigured()).toBe(false);
  });

  test('starts with the code GitHub returned and never exposes the device code', async () => {
    const { flow, fetchMock } = setup([]);

    const status = await flow.start();

    expect(status).toEqual({
      state: 'pending',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
      expiresAt: '2026-10-30T12:15:00.000Z',
    });
    expect(JSON.stringify(status)).not.toContain('dev-secret-code');
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      client_id: 'Iv1.client',
      scope: GITHUB_OAUTH_SCOPES,
    });
    expect(new Headers(init?.headers).get('accept')).toBe('application/json');
    flow.cancel();
  });

  test('polls at the given interval and hands over the token', async () => {
    const { flow, onToken, sleeps, polls } = setup([
      { error: 'authorization_pending' },
      { access_token: 'gho_new', token_type: 'bearer', scope: 'repo,read:org' },
    ]);

    await flow.start();
    await flow.settled();

    expect(sleeps).toEqual([5000, 5000]);
    expect(polls[0]).toEqual({
      client_id: 'Iv1.client',
      device_code: 'dev-secret-code',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    expect(onToken).toHaveBeenCalledWith('gho_new', { isCurrent: expect.any(Function) });
    expect(flow.status()).toEqual({ state: 'complete' });
  });

  test('slows down by five seconds when GitHub asks', async () => {
    const { flow, sleeps } = setup([
      { error: 'slow_down', interval: 10 },
      { access_token: 'gho_new' },
    ]);

    await flow.start();
    await flow.settled();

    expect(sleeps).toEqual([5000, 10_000]);
  });

  test.each([
    ['expired_token', 'expired'],
    ['access_denied', 'denied'],
  ] as const)('reports %s as %s', async (error, state) => {
    const { flow, onToken } = setup([{ error }]);

    await flow.start();
    await flow.settled();

    expect(flow.status().state).toBe(state);
    expect(onToken).not.toHaveBeenCalled();
  });

  test('reports other errors with their description', async () => {
    const { flow } = setup([
      { error: 'device_flow_disabled', error_description: 'Device flow is not enabled' },
    ]);

    await flow.start();
    await flow.settled();

    expect(flow.status()).toEqual({ state: 'error', error: 'Device flow is not enabled' });
  });

  test('expires once the code is past its lifetime without asking GitHub again', async () => {
    const { flow, polls } = setup(
      Array.from({ length: 500 }, () => ({ error: 'authorization_pending' })),
    );

    await flow.start();
    await flow.settled();

    expect(flow.status().state).toBe('expired');
    expect(polls.length).toBeLessThanOrEqual(180);
  });

  test('fails when saving the token fails', async () => {
    const { flow, onToken } = setup([{ access_token: 'gho_new' }]);
    onToken.mockRejectedValueOnce(new Error('Bad credentials'));

    await flow.start();
    await flow.settled();

    expect(flow.status()).toEqual({
      state: 'error',
      error: 'Signed in, but the token did not work: Bad credentials',
    });
  });

  test('cancel stops polling and goes back to idle', async () => {
    const { flow, onToken } = setup([{ access_token: 'gho_new' }]);

    await flow.start();
    flow.cancel();
    await flow.settled();

    expect(flow.status()).toEqual({ state: 'idle' });
    expect(onToken).not.toHaveBeenCalled();
  });

  test.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://github.com.evil.example/login/device',
  ])(
    'refuses a verification link to %s, since the UI renders it as a link',
    async (verificationUri) => {
      const flow = new DeviceFlow({
        clientId: 'Iv1.client',
        onToken: async () => undefined,
        log: () => undefined,
        fetch: async () => json({ ...CODE_RESPONSE, verification_uri: verificationUri }),
      });

      await expect(flow.start()).rejects.toMatchObject({ status: 502, code: 'upstreamFailed' });
      expect(flow.status()).toEqual({ state: 'idle' });
    },
  );

  test('refuses to start without a client ID', async () => {
    const { flow, fetchMock } = setup([], null);

    await expect(flow.start()).rejects.toMatchObject({ status: 409, code: 'missingConfig' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a second start replaces the first code, whose poll loop stops', async () => {
    let codes = 0;
    const polled: Array<string> = [];
    const flow = new DeviceFlow({
      clientId: 'Iv1.client',
      onToken: async () => undefined,
      log: () => undefined,
      sleep: async () => undefined,
      fetch: async (url, init) => {
        const body = z
          .object({ device_code: z.string().optional() })
          .parse(JSON.parse(String(init.body)));
        if (url.endsWith('/login/device/code')) {
          codes++;
          return json({
            ...CODE_RESPONSE,
            device_code: `dev-${codes}`,
            user_code: `CODE-${codes}`,
          });
        }
        polled.push(body.device_code ?? '');
        return json({ error: 'access_denied' });
      },
    });

    const [, second] = await Promise.all([flow.start(), flow.start()]);
    await flow.settled();

    expect(second.userCode).toBe('CODE-2');
    expect(polled).toEqual(['dev-2']);
    expect(flow.status().state).toBe('denied');
  });

  test('drops a token for the first code that arrives after a restart, and keeps polling the second', async () => {
    let codes = 0;
    let releaseFirstPoll: (() => void) | undefined;
    const polled: Array<string> = [];
    const onToken = vi.fn(async (_token: string) => undefined);
    const flow = new DeviceFlow({
      clientId: 'Iv1.client',
      onToken,
      log: () => undefined,
      sleep: async () => undefined,
      fetch: async (url, init) => {
        const body = z
          .object({ device_code: z.string().optional() })
          .parse(JSON.parse(String(init.body)));
        if (url.endsWith('/login/device/code')) {
          codes++;
          return json({
            ...CODE_RESPONSE,
            device_code: `dev-${codes}`,
            user_code: `CODE-${codes}`,
          });
        }
        polled.push(body.device_code ?? '');
        if (body.device_code === 'dev-1') {
          await new Promise<void>((resolve) => {
            releaseFirstPoll = resolve;
          });
          return json({ access_token: 'gho_first' });
        }
        return json({ access_token: 'gho_second' });
      },
    });

    await flow.start();
    await vi.waitFor(() => expect(releaseFirstPoll).toBeDefined());
    const first = flow.settled();
    await flow.start();
    await flow.settled();
    releaseFirstPoll?.();
    await first;

    expect(polled).toEqual(['dev-1', 'dev-2']);
    expect(onToken.mock.calls.map(([token]) => token)).toEqual(['gho_second']);
    expect(flow.status()).toEqual({ state: 'complete' });
  });

  test('tells onToken the sign-in was cancelled while the token was being checked', async () => {
    const { flow, onToken } = setup([{ access_token: 'gho_new' }]);
    let isCurrent: (() => boolean) | undefined;
    onToken.mockImplementationOnce(async (_token, context) => {
      flow.cancel();
      isCurrent = context?.isCurrent;
    });

    await flow.start();
    await flow.settled();

    expect(isCurrent?.()).toBe(false);
    expect(flow.status()).toEqual({ state: 'idle' });
  });

  test('a restart that fails goes back to idle and answers 502', async () => {
    let calls = 0;
    const flow = new DeviceFlow({
      clientId: 'Iv1.client',
      onToken: async () => undefined,
      log: () => undefined,
      sleep: () => new Promise(() => undefined),
      fetch: async () => {
        calls++;
        if (calls > 1) {
          throw new TypeError('fetch failed');
        }
        return json(CODE_RESPONSE);
      },
    });
    await flow.start();

    await expect(flow.start()).rejects.toMatchObject({ status: 502, code: 'upstreamFailed' });
    expect(flow.status()).toEqual({ state: 'idle' });
  });

  test('a reply without a code goes back to idle and answers 502', async () => {
    const flow = new DeviceFlow({
      clientId: 'Iv1.client',
      onToken: async () => undefined,
      log: () => undefined,
      fetch: async () =>
        json({ error: 'unauthorized_client', error_description: 'Bad client' }, 400),
    });

    await expect(flow.start()).rejects.toMatchObject({
      status: 502,
      code: 'upstreamFailed',
      message: "GitHub didn't start the sign-in: Bad client",
    });
    expect(flow.status()).toEqual({ state: 'idle' });
  });

  test('acknowledging a completed sign-in goes back to idle', async () => {
    const { flow } = setup([{ access_token: 'gho_new' }]);
    await flow.start();
    await flow.settled();

    flow.acknowledgeComplete();

    expect(flow.status()).toEqual({ state: 'idle' });
  });

  test('acknowledging leaves a sign-in that is still pending alone', async () => {
    const { flow } = setup([]);
    await flow.start();

    flow.acknowledgeComplete();

    expect(flow.status().state).toBe('pending');
    flow.cancel();
  });
});
