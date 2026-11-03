import { createHash, timingSafeEqual } from 'node:crypto';

import { ApiError, type RawRoute, REQUEST_SECRET_COOKIE } from './router.ts';

/** Opened as `BOOTSTRAP_PATH?code=<code>` by the window of the app that started the server. */
export const BOOTSTRAP_PATH = '/__bootstrap';
/** The window opens the link as soon as the server listens, so the code needn't last long. */
export const BOOTSTRAP_TTL_MS = 30_000;
/** 32 random bytes in base64url. */
const MIN_LENGTH = 43;
const COOKIE_SAFE = /^[\w-]+$/;

export interface BootstrapOptions {
  /** A one-time code the app generated and gave only to the server and its own window. */
  code: string;
  requestSecret: string;
  now?: () => number;
}

export interface BootstrapRoute extends RawRoute {
  /**
   * Replaces the code with a new one, which works once within `BOOTSTRAP_TTL_MS` from now, so the
   * window can get the cookie again, such as when the player reloads it.
   */
  reissue: (code: string) => void;
}

/**
 * Hands the request secret's cookie to the window of an app that can't set cookies in its webview
 * itself, such as Tauri. The code works once and only for `BOOTSTRAP_TTL_MS` after it was issued,
 * so a program that later finds it, say in the webview's history, gets nothing. The route is
 * exempt from the request secret check but not from the Host, Origin and `Sec-Fetch-Site` ones.
 */
export function bootstrapRoute({
  code,
  requestSecret,
  now = Date.now,
}: BootstrapOptions): BootstrapRoute {
  if (requestSecret.length < MIN_LENGTH || !COOKIE_SAFE.test(requestSecret)) {
    throw new Error(
      `The request secret must be at least ${MIN_LENGTH} base64url characters, which a cookie carries as they are`,
    );
  }
  let expected: Buffer;
  let expiresAt: number;
  let used: boolean;
  const reissue = (next: string): void => {
    if (next.length < MIN_LENGTH) {
      throw new Error(`The bootstrap code must be at least ${MIN_LENGTH} characters`);
    }
    expected = digest(next);
    expiresAt = now() + BOOTSTRAP_TTL_MS;
    used = false;
  };
  reissue(code);
  return {
    reissue,
    method: 'GET',
    path: BOOTSTRAP_PATH,
    skipsRequestSecret: true,
    handle: (req, res) => {
      const sent = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('code');
      // A wrong code doesn't use up the real one, which has too many bits to guess.
      if (used || now() > expiresAt || sent === null || !timingSafeEqual(digest(sent), expected)) {
        throw new ApiError(403, 'forbidden', 'This start-up link has expired or was already used');
      }
      used = true;
      res
        .writeHead(303, {
          Location: '/',
          'Set-Cookie': `${REQUEST_SECRET_COOKIE}=${requestSecret}; Path=/; HttpOnly; SameSite=Strict`,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        })
        .end();
    },
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
