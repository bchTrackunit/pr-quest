import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 500;

export class GhError extends Error {
  /** HTTP status, parsed from `gh: ... (HTTP 422)` (`gh api`) or `HTTP 403: ...` (`gh search`). */
  public readonly httpStatus?: number;
  /** What `gh` printed before failing; `gh api graphql` prints partial data here. */
  public readonly stdout?: string;

  public constructor(message: string, httpStatus?: number, stdout?: string) {
    super(message);
    this.name = 'GhError';
    this.httpStatus = httpStatus;
    this.stdout = stdout;
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
          reject(toGhError(error, String(stderr), String(stdout)));
          return;
        }
        resolve(String(stdout));
      },
    );
    child.stdin?.end(options.input ?? '');
  });

export function parseHttpStatus(message: string): number | undefined {
  const match = /\(HTTP (\d{3})\)|\bHTTP (\d{3}):/.exec(message);
  const status = match?.[1] ?? match?.[2];
  return status ? Number(status) : undefined;
}

function toGhError(error: Error & { code?: unknown }, stderr: string, stdout: string): GhError {
  if (error.code === 'ENOENT') {
    return new GhError('gh CLI not found on PATH; install it and run `gh auth login`');
  }
  const message = stderr.trim() || error.message;
  return new GhError(
    message.slice(0, MAX_MESSAGE_LENGTH),
    parseHttpStatus(message),
    stdout || undefined,
  );
}
