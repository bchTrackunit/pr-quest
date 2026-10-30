import { describe, expect, test, vi } from 'vitest';

import { DeviceFlow, GITHUB_OAUTH_SCOPES } from './deviceFlow.ts';

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
  const onToken = vi.fn(async (_token: string) => undefined);
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
    expect(onToken).toHaveBeenCalledWith('gho_new');
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

  test('refuses to start without a client ID', async () => {
    const { flow, fetchMock } = setup([], null);

    await expect(flow.start()).rejects.toMatchObject({ status: 409, code: 'missingConfig' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
