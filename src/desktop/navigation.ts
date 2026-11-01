/** Schemes the system may open for a link in the UI; anything else could launch a local program. */
const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'http:', 'mailto:']);

/** Browser permissions the UI uses: desktop notifications and copying the sign-in code. */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'notifications',
  'clipboard-sanitized-write',
]);

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** Whether `url` is a page of the app itself, served by its own server at `appOrigin`. */
export function isAppUrl(url: string, appOrigin: string): boolean {
  return parse(url)?.origin === appOrigin;
}

/** The URL to hand to the system browser, or `undefined` when it isn't a web or mail link. */
export function externalUrl(url: string): string | undefined {
  const parsed = parse(url);
  return parsed && EXTERNAL_PROTOCOLS.has(parsed.protocol) ? parsed.href : undefined;
}

/** Whether the page at `requestingUrl` may use `permission`: only the app, and only what it needs. */
export function isAllowedPermission(
  permission: string,
  requestingUrl: string,
  appOrigin: string,
): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingUrl, appOrigin);
}
