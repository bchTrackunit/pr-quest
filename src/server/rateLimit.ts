import { z } from 'zod';

import type { RateLimitKind } from '../shared/api.ts';
import { GitHubApiError } from './githubApi.ts';

export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 10 * 60_000;
/** Waits a little past GitHub's reset time so the first retry doesn't land a moment too early. */
const RESET_MARGIN_MS = 2000;
/** GitHub's quotas reset hourly, so a longer wait means a bad header, not a real limit. */
export const MAX_RESET_WAIT_MS = 60 * 60_000;

const SECONDARY_PATTERN = /secondary rate limit|abuse detection|abuse mechanism/i;
const PRIMARY_PATTERN = /rate limit exceeded|rate_limited/i;

/** A quest-list backoff: no GitHub calls for the quest list before `limitedUntil`. */
export interface Backoff {
  kind: RateLimitKind;
  limitedUntil: Date;
  /** Consecutive rate-limited fetches, which drives the exponential delay. */
  attempt: number;
}

/**
 * Which rate limit a failed GitHub call hit, or `undefined` when it wasn't a rate limit. The
 * response headers decide first; then the message. HTTP 429 is always a rate limit. HTTP 403 only
 * counts when the headers or message say so, because GitHub also answers 403 for missing
 * permissions and SAML enforcement.
 */
export function detectRateLimit(error: unknown): RateLimitKind | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const apiError = error instanceof GitHubApiError ? error : undefined;
  if (apiError?.rateLimit) {
    return apiError.rateLimit.kind;
  }
  const text = `${error.message}\n${apiError?.body ?? ''}`;
  if (SECONDARY_PATTERN.test(text)) {
    return 'secondary';
  }
  if (PRIMARY_PATTERN.test(text)) {
    return 'primary';
  }
  if (apiError?.httpStatus === 429) {
    return 'secondary';
  }
  return undefined;
}

export function isRateLimitError(error: unknown): boolean {
  return detectRateLimit(error) !== undefined;
}

/** When the limit lifts, from `x-ratelimit-reset` or `retry-after` on the failed response. */
export function rateLimitResetOf(error: unknown): Date | undefined {
  return error instanceof GitHubApiError ? error.rateLimit?.resetAt : undefined;
}

/** 60 s for the first hit, doubling per consecutive hit, capped at 10 minutes. */
export function backoffDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(exponent, 16), BACKOFF_MAX_MS);
}

const ResourceSchema = z.object({
  remaining: z.number(),
  reset: z.number(),
});

const RateLimitResponseSchema = z.object({
  resources: z.object({
    search: ResourceSchema.optional(),
    graphql: ResourceSchema.optional(),
    core: ResourceSchema.optional(),
  }),
});

/**
 * The latest reset time among the exhausted quotas in a `GET /rate_limit` response. Search is the
 * one PR Quest usually exhausts; GraphQL and core are checked too. Returns `undefined` when the
 * output can't be read or no quota is at zero.
 */
export function parseRateLimitReset(text: string): Date | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = RateLimitResponseSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const { search, graphql, core } = parsed.data.resources;
  const resets = [search, graphql, core].flatMap((resource) =>
    resource && resource.remaining <= 0 ? [resource.reset] : [],
  );
  return resets.length > 0 ? new Date(Math.max(...resets) * 1000) : undefined;
}

/**
 * The backoff after another rate-limited fetch. A known future reset (a primary limit's reset, or
 * a secondary limit's `retry-after`) is waited out; everything else backs off exponentially.
 */
export function nextBackoff(input: {
  kind: RateLimitKind;
  previous?: Backoff;
  now: Date;
  resetAt?: Date;
}): Backoff {
  const attempt = (input.previous?.attempt ?? 0) + 1;
  const nowMs = input.now.getTime();
  const resetMs = input.resetAt?.getTime();
  const limitedUntilMs =
    resetMs !== undefined && resetMs > nowMs
      ? resetMs + RESET_MARGIN_MS
      : nowMs + backoffDelayMs(attempt);
  return {
    kind: input.kind,
    limitedUntil: new Date(Math.min(limitedUntilMs, nowMs + MAX_RESET_WAIT_MS)),
    attempt,
  };
}
