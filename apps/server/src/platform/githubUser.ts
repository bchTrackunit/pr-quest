/**
 * GitHub logins are letters, digits and hyphens, never starting with a hyphen, at most 39 long.
 * Enterprise Managed User logins add an underscore and the enterprise's shortcode.
 */
const LOGIN_PATTERN = /^[a-z\d][a-z\d_-]{0,38}$/i;

/**
 * A GitHub account as PR Quest stores it. Only `id` identifies the account: a login can be
 * renamed, and once given up another account can take it.
 */
export interface GitHubUser {
  /** GitHub's numeric account id, from `GET /user`, which never changes or passes to another. */
  readonly id: number;
  /** The account's current login, lower-cased. */
  readonly login: string;
}

/** Whether `value` is shaped like a GitHub login. */
export function isGitHubLogin(value: string): boolean {
  return LOGIN_PATTERN.test(value);
}

/** `login` lower-cased, as GitHub logins are case-insensitive. Throws when it isn't a login. */
export function githubLogin(login: string): string {
  if (!isGitHubLogin(login)) {
    throw new Error(`Not a GitHub login: ${JSON.stringify(login.slice(0, 50))}`);
  }
  return login.toLowerCase();
}

/** The account `id` with its login `login`, as `GET /user` reports them. */
export function githubUser(id: number, login: string): GitHubUser {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Not a GitHub account id: ${JSON.stringify(id)}`);
  }
  return { id, login: githubLogin(login) };
}
