import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { GhError, parseHttpStatus } from './gh.ts';
import {
  BACKOFF_MAX_MS,
  backoffDelayMs,
  detectRateLimit,
  nextBackoff,
  parseRateLimitReset,
} from './rateLimit.ts';

const RATE_LIMIT = readFileSync(new URL('./fixtures/gh/rate-limit.json', import.meta.url), 'utf8');
const NOW = new Date('2026-10-30T14:00:00.000Z');

describe('detectRateLimit', () => {
  test.each([
    [
      'gh search primary limit',
      new GhError(
        'HTTP 403: API rate limit exceeded for user ID 123. (https://api.github.com/search/issues?q=x)',
        403,
      ),
      'primary',
    ],
    [
      'GraphQL primary limit',
      new GhError('gh api graphql returned no data: API rate limit exceeded for user ID 123.'),
      'primary',
    ],
    [
      'GraphQL RATE_LIMITED error in stdout',
      new GhError('gh: exit status 1', undefined, '{"errors":[{"type":"RATE_LIMITED"}]}'),
      'primary',
    ],
    [
      'secondary limit',
      new GhError(
        'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)',
        403,
      ),
      'secondary',
    ],
    [
      'abuse detection',
      new GhError('gh: You have triggered an abuse detection mechanism.'),
      'secondary',
    ],
    ['bare HTTP 429', new GhError('gh: Too Many Requests (HTTP 429)', 429), 'secondary'],
    ['plain Error with the wording', new Error('API rate limit exceeded'), 'primary'],
  ])('detects a %s', (_name, error, kind) => {
    expect(detectRateLimit(error)).toBe(kind);
  });

  test.each([
    [
      'a SAML 403',
      new GhError('gh: Resource protected by organization SAML enforcement. (HTTP 403)', 403),
    ],
    ['a 502', new GhError('gh: Bad Gateway (HTTP 502)', 502)],
    ['a non-error', 'API rate limit exceeded'],
  ])('ignores %s', (_name, error) => {
    expect(detectRateLimit(error)).toBeUndefined();
  });
});

describe('parseHttpStatus', () => {
  test('reads the status from gh api and gh search messages', () => {
    expect(parseHttpStatus('gh: Not Found (HTTP 404)')).toBe(404);
    expect(parseHttpStatus('HTTP 403: API rate limit exceeded for user ID 1.')).toBe(403);
    expect(parseHttpStatus('no status here')).toBeUndefined();
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
