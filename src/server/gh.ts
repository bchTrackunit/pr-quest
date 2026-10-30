import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 500;

export class GhError extends Error {
  /** HTTP status from a `gh api` failure, parsed from `gh: ... (HTTP 422)`. */
  public readonly httpStatus?: number;

  public constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = 'GhError';
    this.httpStatus = httpStatus;
  }
}

export interface RunGhOptions {
  /** Written to the process's stdin, e.g. a JSON body for `gh api --input -`. */
  input?: string;
  timeoutMs?: number;
}

/** Runs `gh` and resolves with stdout. Uses `gh` as the player's GitHub identity. */
export type GhRunner = (args: Array<string>, options?: RunGhOptions) => Promise<string>;

/** Runs `gh` without a shell, so arguments are never interpreted. */
export const runGh: GhRunner = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      args,
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(toGhError(error, String(stderr)));
          return;
        }
        resolve(String(stdout));
      },
    );
    child.stdin?.end(options.input ?? '');
  });

function toGhError(error: Error & { code?: unknown }, stderr: string): GhError {
  if (error.code === 'ENOENT') {
    return new GhError('gh CLI not found on PATH; install it and run `gh auth login`');
  }
  const message = stderr.trim() || error.message;
  const status = /\(HTTP (\d{3})\)/.exec(message)?.[1];
  return new GhError(message.slice(0, MAX_MESSAGE_LENGTH), status ? Number(status) : undefined);
}
