import { z } from 'zod';

import type { DeviceFlowStatus } from '../shared/api.ts';
import type { FetchLike } from './githubApi.ts';
import { ApiError } from './router.ts';

/** `repo` to read and review private PRs, `read:org` to see which team a request came through. */
export const GITHUB_OAUTH_SCOPES = 'repo read:org';

const GITHUB_URL = 'https://github.com';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const SLOW_DOWN_STEP_MS = 5000;
const REQUEST_TIMEOUT_MS = 15_000;

const DeviceCodeSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  expires_in: z.number().positive(),
  interval: z.number().nonnegative().optional(),
});

const TokenReplySchema = z.object({
  access_token: z.string().min(1).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  interval: z.number().nonnegative().optional(),
});

const ErrorReplySchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
  message: z.string().optional(),
});

export interface TokenContext {
  /** False once the sign-in was cancelled or restarted; the token must not be saved then. */
  isCurrent: () => boolean;
}

export interface DeviceFlowOptions {
  /** The OAuth App's client ID; the flow can't start without one. */
  clientId: string | undefined;
  /**
   * Saves the new token. A rejection fails the sign-in with its message. Check `isCurrent()` right
   * before saving: a cancel or sign-out can land while the token is being checked.
   */
  onToken: (token: string, context: TokenContext) => Promise<void>;
  log: (message: string) => void;
  fetch?: FetchLike;
  baseUrl?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * "Sign in with GitHub" without a client secret or a callback: GitHub shows the player a code to
 * enter on github.com while this server polls for the token. The device code stays here.
 */
export class DeviceFlow {
  private readonly options: DeviceFlowOptions;
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private current: DeviceFlowStatus = { state: 'idle' };
  /** Bumped by every start and cancel; a poll loop from an older generation stops. */
  private generation = 0;
  private polling: Promise<void> = Promise.resolve();

  public constructor(options: DeviceFlowOptions) {
    this.options = options;
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  public async start(): Promise<DeviceFlowStatus> {
    const clientId = this.options.clientId;
    if (!clientId) {
      throw new ApiError(
        409,
        'missingConfig',
        'Sign in with GitHub needs an OAuth App: set PR_QUEST_GITHUB_CLIENT_ID (see the README), or log in with `gh auth login` instead.',
      );
    }
    const generation = ++this.generation;
    let code: z.infer<typeof DeviceCodeSchema>;
    try {
      code = await this.requestCode(clientId);
    } catch (error) {
      // The previous code's poll loop has already stopped, so its status would never change.
      if (generation === this.generation) {
        this.current = { state: 'idle' };
      }
      throw error instanceof ApiError
        ? error
        : new ApiError(502, 'upstreamFailed', `GitHub didn't start the sign-in: ${errorMessage(error)}`);
    }
    if (generation !== this.generation) {
      return this.current;
    }
    const expiresAtMs = this.now() + code.expires_in * 1000;
    this.current = {
      state: 'pending',
      userCode: code.user_code,
      verificationUri: code.verification_uri,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    this.polling = this.poll(generation, clientId, code.device_code, {
      intervalMs: (code.interval ?? 5) * 1000,
      expiresAtMs,
    });
    return this.current;
  }

  public status(): DeviceFlowStatus {
    return this.current;
  }

  public cancel(): void {
    this.generation++;
    this.current = { state: 'idle' };
  }

  /** Once the signed-in account has been reported, a finished sign-in goes back to idle. */
  public acknowledgeComplete(): void {
    if (this.current.state === 'complete') {
      this.current = { state: 'idle' };
    }
  }

  /** Resolves once the current poll loop has stopped; for tests. */
  public settled(): Promise<void> {
    return this.polling;
  }

  private async poll(
    generation: number,
    clientId: string,
    deviceCode: string,
    timing: { intervalMs: number; expiresAtMs: number },
  ): Promise<void> {
    let intervalMs = timing.intervalMs;
    for (;;) {
      await this.sleep(intervalMs);
      if (generation !== this.generation) {
        return;
      }
      if (this.now() >= timing.expiresAtMs) {
        this.current = { state: 'expired' };
        return;
      }
      let reply: z.infer<typeof TokenReplySchema>;
      try {
        reply = TokenReplySchema.parse(
          await this.post('/login/oauth/access_token', {
            client_id: clientId,
            device_code: deviceCode,
            grant_type: DEVICE_GRANT_TYPE,
          }),
        );
      } catch (error) {
        this.options.log(`Sign-in poll failed, retrying: ${errorMessage(error)}`);
        continue;
      }
      if (generation !== this.generation) {
        return;
      }
      if (reply.access_token) {
        await this.complete(generation, reply.access_token);
        return;
      }
      switch (reply.error) {
        case 'authorization_pending':
          continue;
        case 'slow_down':
          intervalMs = Math.max(intervalMs + SLOW_DOWN_STEP_MS, (reply.interval ?? 0) * 1000);
          continue;
        case 'expired_token':
          this.current = { state: 'expired' };
          return;
        case 'access_denied':
          this.current = { state: 'denied' };
          return;
        default:
          this.current = { state: 'error', error: describeError(reply) ?? 'Unexpected reply' };
          return;
      }
    }
  }

  private async requestCode(clientId: string): Promise<z.infer<typeof DeviceCodeSchema>> {
    const reply = await this.post('/login/device/code', {
      client_id: clientId,
      scope: GITHUB_OAUTH_SCOPES,
    });
    const code = DeviceCodeSchema.safeParse(reply);
    if (!code.success) {
      throw new ApiError(
        502,
        'upstreamFailed',
        `GitHub didn't start the sign-in: ${describeError(reply) ?? 'unexpected reply'}`,
      );
    }
    return code.data;
  }

  private async complete(generation: number, token: string): Promise<void> {
    try {
      await this.options.onToken(token, { isCurrent: () => generation === this.generation });
      if (generation === this.generation) {
        this.current = { state: 'complete' };
      }
    } catch (error) {
      if (generation === this.generation) {
        this.current = {
          state: 'error',
          error: `Signed in, but the token did not work: ${errorMessage(error)}`,
        };
      }
    }
  }

  private async post(path: string, body: Record<string, string>): Promise<unknown> {
    const response = await this.fetch(`${this.options.baseUrl ?? GITHUB_URL}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'pr-quest',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GitHub answered HTTP ${response.status} without JSON`);
    }
  }
}

function describeError(reply: unknown): string | undefined {
  const parsed = ErrorReplySchema.safeParse(reply);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.error_description ?? parsed.data.message ?? parsed.data.error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
