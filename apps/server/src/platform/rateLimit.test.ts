import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { GitHubApiError } from './githubApi.ts';
import {
  BACKOFF_MAX_MS,
  backoffDelayMs,
  detectRateLimit,
  nextBackoff,
  parseRateLimitReset,
  rateLimitResetOf,
} from './rateLimit.ts';

const RATE_LIMIT = readFileSync(
  new URL('./fixtures/github/rate-limit.json', import.meta.url),
  'utf8',
);
const NOW = new Date('2026-10-30T14:00:00.000Z');

describe('detectRateLimit', () => {
  test.each([
    [
      'search primary limit',
      new GitHubApiError(
        'GitHub GET /search/issues failed (HTTP 403): API rate limit exceeded for user ID 123.',
        { httpStatus: 403 },
      ),
      'primary',
    ],
    [
      'GraphQL primary limit',
      new GitHubApiError(
        'GitHub GraphQL returned no data: API rate limit exceeded for user ID 123.',
      ),
      'primary',
    ],
    [
      'GraphQL RATE_LIMITED error in the body',
      new GitHubApiError('GitHub GraphQL failed', { body: '{"errors":[{"type":"RATE_LIMITED"}]}' }),
      'primary',
    ],
    [
      'secondary limit',
      new GitHubApiError(
        'GitHub GET /search/issues failed (HTTP 403): You have exceeded a secondary rate limit.',
        { httpStatus: 403 },
      ),
      'secondary',
    ],
    [
      'abuse detection',
      new GitHubApiError('You have triggered an abuse detection mechanism.'),
      'secondary',
    ],
    ['bare HTTP 429', new GitHubApiError('Too Many Requests', { httpStatus: 429 }), 'secondary'],
    [
      'limit named only by the headers',
      new GitHubApiError('Forbidden', { httpStatus: 403, rateLimit: { kind: 'primary' } }),
      'primary',
    ],
    ['plain Error with the wording', new Error('API rate limit exceeded'), 'primary'],
  ])('detects a %s', (_name, error, kind) => {
    expect(detectRateLimit(error)).toBe(kind);
  });

  test.each([
    [
      'a SAML 403',
      new GitHubApiError('Resource protected by organization SAML enforcement.', {
        httpStatus: 403,
      }),
    ],
    ['a 502', new GitHubApiError('Bad Gateway', { httpStatus: 502 })],
    ['a non-error', 'API rate limit exceeded'],
  ])('ignores %s', (_name, error) => {
    expect(detectRateLimit(error)).toBeUndefined();
  });
});

describe('rateLimitResetOf', () => {
  test('returns the reset time the response headers gave', () => {
    const resetAt = new Date('2026-10-30T14:05:00.000Z');
    const error = new GitHubApiError('limited', { rateLimit: { kind: 'primary', resetAt } });

    expect(rateLimitResetOf(error)).toEqual(resetAt);
  });

  test('returns undefined without a reset time', () => {
    expect(rateLimitResetOf(new GitHubApiError('limited'))).toBeUndefined();
    expect(rateLimitResetOf(new Error('x'))).toBeUndefined();
  });
});

describe('parseRateLimitReset', () => {
  test('returns the reset of the exhausted search quota', () => {
    expect(parseRateLimitReset(RATE_LIMIT)?.toISOString()).toBe('2026-10-30T14:01:00.000Z');
  });

  test('takes the latest reset when several quotas are exhausted', () => {
    const value = JSON.parse(RATE_LIMIT);
    value.resources.core.remaining = 0;
    expect(parseRateLimitReset(JSON.stringify(value))?.toISOString()).toBe(
      '2026-10-30T15:00:00.000Z',
    );
  });

  test('returns undefined when no quota is exhausted or the output is unreadable', () => {
    const value = JSON.parse(RATE_LIMIT);
    value.resources.search.remaining = 3;
    expect(parseRateLimitReset(JSON.stringify(value))).toBeUndefined();
    expect(parseRateLimitReset('not json')).toBeUndefined();
    expect(parseRateLimitReset('{"resources":{"search":{"remaining":"0"}}}')).toBeUndefined();
  });
});

describe('backoffDelayMs', () => {
  test('starts at 60 seconds, doubles, and caps at 10 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(backoffDelayMs)).toEqual([
      60_000,
      120_000,
      240_000,
      480_000,
      BACKOFF_MAX_MS,
      BACKOFF_MAX_MS,
      BACKOFF_MAX_MS,
    ]);
  });
});

describe('nextBackoff', () => {
  test('waits for a known primary reset, plus a small margin', () => {
    const backoff = nextBackoff({
      kind: 'primary',
      now: NOW,
      resetAt: new Date('2026-10-30T14:00:40.000Z'),
    });

    expect(backoff).toEqual({
      kind: 'primary',
      limitedUntil: new Date('2026-10-30T14:00:42.000Z'),
      attempt: 1,
    });
  });

  test("waits for a secondary limit's Retry-After, plus a small margin", () => {
    const backoff = nextBackoff({
      kind: 'secondary',
      now: NOW,
      resetAt: new Date('2026-10-30T14:00:30.000Z'),
    });

    expect(backoff.limitedUntil).toEqual(new Date('2026-10-30T14:00:32.000Z'));
  });

  test('never waits more than an hour, whatever the reset says', () => {
    const backoff = nextBackoff({
      kind: 'secondary',
      now: NOW,
      resetAt: new Date(NOW.getTime() + 999_999_999_000),
    });

    expect(backoff.limitedUntil).toEqual(new Date(NOW.getTime() + 60 * 60_000));
  });

  test('backs off exponentially for secondary limits and unknown resets', () => {
    const first = nextBackoff({ kind: 'secondary', now: NOW });
    const second = nextBackoff({ kind: 'secondary', now: NOW, previous: first });
    const pastReset = nextBackoff({
      kind: 'primary',
      now: NOW,
      previous: second,
      resetAt: new Date('2026-10-30T13:59:00.000Z'),
    });

    expect(first.limitedUntil.toISOString()).toBe('2026-10-30T14:01:00.000Z');
    expect(second).toMatchObject({
      attempt: 2,
      limitedUntil: new Date('2026-10-30T14:02:00.000Z'),
    });
    expect(pastReset).toMatchObject({
      kind: 'primary',
      attempt: 3,
      limitedUntil: new Date('2026-10-30T14:04:00.000Z'),
    });
  });
});
