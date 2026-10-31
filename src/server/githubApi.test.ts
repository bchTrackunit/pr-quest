import { describe, expect, test, vi } from 'vitest';

import {
  GitHubApi,
  GitHubApiError,
  GitHubNetworkError,
  NotSignedInError,
  type FetchLike,
} from './githubApi.ts';

const NOW = new Date('2026-10-30T14:00:00.000Z');

function respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers });
}

function api(fetchMock: FetchLike, token: string | null = 'gho_secret'): GitHubApi {
  return new GitHubApi({ token: async () => token ?? undefined, fetch: fetchMock, now: () => NOW });
}

describe('GitHubApi.request', () => {
  test('calls the REST API with the token, API version and JSON accept header', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => respond(200, { login: 'me' }));

    await expect(api(fetchMock).request('GET', '/user')).resolves.toBe('{"login":"me"}');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.github.com/user');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer gho_secret',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  test('sends a JSON body and a custom accept header', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => respond(200, 'diff --git a/x b/x'));

    await api(fetchMock).request('POST', '/repos/o/r/pulls/1/reviews', {
      body: { event: 'COMMENT' },
      accept: 'application/vnd.github.diff',
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBe('{"event":"COMMENT"}');
    expect(init?.headers).toMatchObject({
      Accept: 'application/vnd.github.diff',
      'Content-Type': 'application/json',
    });
  });

  test('encodes query parameters', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => respond(200, {}));

    await api(fetchMock).request('GET', '/search/issues', {
      query: { q: 'is:pr review-requested:@me', per_page: '100' },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/search/issues?q=is%3Apr+review-requested%3A%40me&per_page=100',
    );
  });

  test('rejects with NotSignedInError and makes no call without a token', async () => {
    const fetchMock = vi.fn<FetchLike>();

    await expect(api(fetchMock, null).request('GET', '/user')).rejects.toBeInstanceOf(
      NotSignedInError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects with GitHub's message, the status and the body", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      respond(422, { message: 'Validation Failed', errors: [{ field: 'line' }] }),
    );

    const error = await api(fetchMock)
      .request('POST', '/repos/o/r/pulls/1/reviews', { body: {} })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({
      httpStatus: 422,
      message: 'GitHub POST /repos/o/r/pulls/1/reviews failed (HTTP 422): Validation Failed',
      body: expect.stringContaining('"field":"line"'),
    });
  });

  test('never puts the token in an error', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => {
      throw new TypeError('fetch failed');
    });

    const error = await api(fetchMock)
      .request('GET', '/user')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubNetworkError);
    expect(JSON.stringify(error)).not.toContain('gho_secret');
    expect(String(error)).toContain('fetch failed');
  });

  test('reads a primary rate limit and its reset time from the headers', async () => {
    const reset = Math.floor(NOW.getTime() / 1000) + 90;
    const fetchMock = vi.fn<FetchLike>(async () =>
      respond(
        403,
        { message: 'API rate limit exceeded for user ID 1.' },
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      ),
    );

    const error = await api(fetchMock)
      .request('GET', '/search/issues')
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      httpStatus: 403,
      rateLimit: { kind: 'primary', resetAt: new Date(reset * 1000) },
    });
  });

  test('reads a secondary rate limit from Retry-After', async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      respond(
        403,
        { message: 'You have exceeded a secondary rate limit.' },
        { 'retry-after': '30' },
      ),
    );

    const error = await api(fetchMock)
      .request('GET', '/search/issues')
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      rateLimit: { kind: 'secondary', resetAt: new Date(NOW.getTime() + 30_000) },
    });
  });

  test('reports which token GitHub rejected with a 401', async () => {
    const onUnauthorized = vi.fn();
    const fetchMock = vi.fn<FetchLike>(async () => respond(401, { message: 'Bad credentials' }));
    const client = new GitHubApi({ token: async () => 'gho_secret', fetch: fetchMock, onUnauthorized });

    await expect(client.request('GET', '/user')).rejects.toMatchObject({ httpStatus: 401 });
    await expect(client.graphql('query { viewer { login } }', {})).rejects.toMatchObject({
      httpStatus: 401,
    });

    expect(onUnauthorized).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledWith('gho_secret');
  });

  test('does not report other failures as a rejected token', async () => {
    const onUnauthorized = vi.fn();
    const fetchMock = vi.fn<FetchLike>(async () => respond(403, { message: 'Forbidden' }));
    const client = new GitHubApi({ token: async () => 'gho_secret', fetch: fetchMock, onUnauthorized });

    await client.request('GET', '/user').catch(() => undefined);

    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  test('a 403 without rate-limit headers carries no rate limit', async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      respond(403, { message: 'Resource protected by organization SAML enforcement.' }),
    );

    const error = await api(fetchMock)
      .request('GET', '/user')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ httpStatus: 403, rateLimit: undefined });
  });
});

describe('GitHubApi.graphql', () => {
  test('posts the query and variables and returns the body, partial errors included', async () => {
    const body = { data: { pr0: null }, errors: [{ message: 'Could not resolve', path: ['pr0'] }] };
    const fetchMock = vi.fn<FetchLike>(async () => respond(200, body));

    const text = await api(fetchMock).graphql('query { viewer { login } }', { a: 1 });

    expect(JSON.parse(text)).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.github.com/graphql');
    expect(JSON.parse(String(init?.body))).toEqual({
      query: 'query { viewer { login } }',
      variables: { a: 1 },
    });
  });

  test('turns a RATE_LIMITED response into a primary rate-limit error with the reset', async () => {
    const reset = Math.floor(NOW.getTime() / 1000) + 600;
    const fetchMock = vi.fn<FetchLike>(async () =>
      respond(
        200,
        { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' }] },
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      ),
    );

    const error = await api(fetchMock)
      .graphql('query { viewer { login } }', {})
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({
      message: expect.stringContaining('API rate limit exceeded'),
      rateLimit: { kind: 'primary', resetAt: new Date(reset * 1000) },
    });
  });
});
