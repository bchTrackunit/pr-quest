import type { RateLimitKind } from '../shared/api.ts';

export const GITHUB_API_URL = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_MESSAGE_LENGTH = 500;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type HttpVerb = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** What a rate-limited response's headers said: which limit, and when it lifts if known. */
export interface RateLimitHint {
  kind: RateLimitKind;
  resetAt?: Date;
}

export class GitHubApiError extends Error {
  public readonly httpStatus?: number;
  /** The response body, e.g. GraphQL errors or a validation failure. Never holds the token. */
  public readonly body?: string;
  public readonly rateLimit?: RateLimitHint;

  public constructor(
    message: string,
    details: { httpStatus?: number; body?: string; rateLimit?: RateLimitHint } = {},
  ) {
    super(message.slice(0, MAX_MESSAGE_LENGTH));
    this.name = 'GitHubApiError';
    this.httpStatus = details.httpStatus;
    this.body = details.body;
    this.rateLimit = details.rateLimit;
  }
}

/** GitHub never answered: the connection failed or timed out. */
export class GitHubNetworkError extends GitHubApiError {
  public constructor(message: string) {
    super(message);
    this.name = 'GitHubNetworkError';
  }
}

/** No GitHub token: the player hasn't signed in and `gh` isn't logged in either. */
export class NotSignedInError extends GitHubApiError {
  public constructor(
    message = 'Sign in with GitHub in Settings (or log in with `gh auth login`) to load your reviews',
  ) {
    super(message);
    this.name = 'NotSignedInError';
  }
}

export interface GitHubRequestOptions {
  body?: unknown;
  accept?: string;
  query?: Record<string, string>;
}

export interface GitHubApiOptions {
  /** The player's token, read per request so signing in or out takes effect right away. */
  token: () => Promise<string | undefined>;
  /** Called with the token GitHub answered 401 for, e.g. one the player revoked. */
  onUnauthorized?: (token: string) => void;
  fetch?: FetchLike;
  baseUrl?: string;
  now?: () => Date;
  timeoutMs?: number;
}

/** GitHub's REST and GraphQL APIs over `fetch`, as the player. */
export class GitHubApi {
  private readonly token: () => Promise<string | undefined>;
  private readonly onUnauthorized: (token: string) => void;
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  public constructor(options: GitHubApiOptions) {
    this.token = options.token;
    this.onUnauthorized = options.onUnauthorized ?? (() => undefined);
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = options.baseUrl ?? GITHUB_API_URL;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Resolves with the response body; rejects with `GitHubApiError` on any non-2xx status. */
  public async request(
    method: HttpVerb,
    path: string,
    options: GitHubRequestOptions = {},
  ): Promise<string> {
    const response = await this.send(method, path, options);
    const text = await response.text();
    if (!response.ok) {
      throw new GitHubApiError(
        `GitHub ${method} ${path} failed (HTTP ${response.status}): ${messageOf(text)}`,
        withRateLimit({ httpStatus: response.status, body: text }, this.rateLimitOf(response)),
      );
    }
    return text;
  }

  /**
   * GraphQL answers 200 with `errors` next to partial `data`, so the body is returned for the
   * caller to split. A rate-limited query fails with the reset time from the headers.
   */
  public async graphql(query: string, variables: Record<string, unknown>): Promise<string> {
    const response = await this.send('POST', '/graphql', { body: { query, variables } });
    const text = await response.text();
    const rateLimit = this.rateLimitOf(response) ?? graphqlRateLimit(text);
    if (!response.ok || (rateLimit && /RATE_LIMITED/.test(text))) {
      throw new GitHubApiError(
        `GitHub GraphQL failed${response.ok ? '' : ` (HTTP ${response.status})`}: ${messageOf(text)}`,
        withRateLimit({ httpStatus: response.status, body: text }, rateLimit),
      );
    }
    return text;
  }

  private async send(
    method: HttpVerb,
    path: string,
    options: GitHubRequestOptions,
  ): Promise<Response> {
    const token = await this.token();
    if (!token) {
      throw new NotSignedInError();
    }
    const search = options.query ? `?${new URLSearchParams(options.query).toString()}` : '';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: options.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'pr-quest',
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}${search}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new GitHubNetworkError(
        `GitHub ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 401) {
      this.onUnauthorized(token);
    }
    return response;
  }

  /**
   * An exhausted quota answers with `x-ratelimit-remaining: 0` and its reset; a secondary limit
   * may send `retry-after`. Plain 403s carry neither, so they stay permission errors.
   */
  private rateLimitOf(response: Response): RateLimitHint | undefined {
    const retryAfter = Number(response.headers.get('retry-after'));
    if (response.headers.has('retry-after') && Number.isFinite(retryAfter)) {
      return { kind: 'secondary', resetAt: new Date(this.now().getTime() + retryAfter * 1000) };
    }
    if (response.headers.get('x-ratelimit-remaining') !== '0') {
      return undefined;
    }
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    return Number.isFinite(reset) && reset > 0
      ? { kind: 'primary', resetAt: new Date(reset * 1000) }
      : { kind: 'primary' };
  }
}

function withRateLimit(
  details: { httpStatus: number; body: string },
  rateLimit: RateLimitHint | undefined,
): { httpStatus: number; body: string; rateLimit?: RateLimitHint } {
  return rateLimit ? { ...details, rateLimit } : details;
}

function graphqlRateLimit(text: string): RateLimitHint | undefined {
  return /"type"\s*:\s*"RATE_LIMITED"/.test(text) ? { kind: 'primary' } : undefined;
}

/** GitHub's `message`, or the first GraphQL error, or the start of the body. */
function messageOf(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value) {
      if ('message' in value && typeof value.message === 'string') {
        return value.message;
      }
      if ('errors' in value && Array.isArray(value.errors)) {
        const first: unknown = value.errors.at(0);
        if (typeof first === 'object' && first && 'message' in first) {
          return String(first.message);
        }
      }
    }
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return text.trim().slice(0, 200) || 'no response body';
}
