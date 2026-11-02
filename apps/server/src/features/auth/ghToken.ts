import { execFile } from 'node:child_process';

const TIMEOUT_MS = 10_000;

/** PR Quest's own secrets, which no child process has any use for. */
export const PRIVATE_ENV_KEYS: ReadonlyArray<string> = [
  'CURSOR_API_KEY',
  'LINEAR_API_KEY',
  'ANTHROPIC_API_KEY',
];

/** The server's environment without PR Quest's secrets, for child processes. */
export function childProcessEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of PRIVATE_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

/**
 * The token of a logged-in GitHub CLI, from `gh auth token`, for players who haven't signed in
 * through PR Quest. `undefined` when gh is missing, logged out or fails.
 */
export const readGhToken = (): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(
      'gh',
      ['auth', 'token'],
      { timeout: TIMEOUT_MS, env: childProcessEnv({ GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }) },
      (error, stdout) => {
        const token = error ? '' : String(stdout).trim();
        resolve(token || undefined);
      },
    );
  });
