import { execFile } from 'node:child_process';
import { posix } from 'node:path';

const TIMEOUT_MS = 10_000;

/**
 * Where Homebrew and most installers put gh on macOS and Linux. An app opened from the Dock or a
 * desktop launcher doesn't get the shell's PATH, so it may have none of them.
 */
const COMMON_BIN_DIRS: ReadonlyArray<string> = ['/opt/homebrew/bin', '/usr/local/bin'];

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
 * The absolute folders in `path`, followed by the usual gh install folders it lacks. Windows
 * installers set PATH themselves.
 */
export function ghSearchPath(
  path: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform === 'win32') {
    return path;
  }
  // An empty or relative entry is searched from the working directory, which may hold anything.
  const entries = (path ?? '').split(posix.delimiter).filter((entry) => posix.isAbsolute(entry));
  const missing = COMMON_BIN_DIRS.filter((dir) => !entries.includes(dir));
  return [...entries, ...missing].join(posix.delimiter);
}

/**
 * The token of a logged-in GitHub CLI, from `gh auth token`, for players who haven't signed in
 * through PR Quest. `undefined` when gh is missing, logged out or fails.
 */
export const readGhToken = (): Promise<string | undefined> =>
  new Promise((resolve) => {
    const extra: NodeJS.ProcessEnv = { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
    if (process.platform !== 'win32') {
      // execFile looks the command up on the PATH of the env it is given.
      extra.PATH = ghSearchPath(process.env.PATH, process.platform);
    }
    execFile(
      'gh',
      ['auth', 'token'],
      { timeout: TIMEOUT_MS, env: childProcessEnv(extra) },
      (error, stdout) => {
        const token = error ? '' : String(stdout).trim();
        resolve(token || undefined);
      },
    );
  });
