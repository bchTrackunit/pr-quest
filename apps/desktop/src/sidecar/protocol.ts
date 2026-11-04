import { z } from 'zod';

import { NOTICE_ACTIONS, type SecretsNotice } from '../secretsNotice.ts';
import { DATA_KEY_BYTES } from './dataKeyEncryptor.ts';

/*
 * The Tauri shell and this sidecar talk over stdio, which no other program can read:
 * - stdin, one JSON line each: first a `Launch`, then any `Command`s. Closing stdin, which happens
 *   when the shell quits or dies, stops the sidecar. `rebootstrap`, when the player reloads the
 *   window, is answered with `BOOTSTRAP_PREFIX` and a new one-time code for the window to open.
 * - stdout, one prefixed JSON line each: `NOTICE_PREFIX` and a `SecretsNotice` for the shell to
 *   show, answered with a `notice` command; `READY_PREFIX` and a `Ready` once the server listens;
 *   `FATAL_PREFIX` and why it couldn't start; then smoke test lines. The shell ignores other
 *   lines. Only these lines go to stdout: `takeStdoutForProtocol` sends whatever else writes to
 *   `process.stdout`, such as console or a dependency, to stderr with the logs.
 */

export const READY_PREFIX = 'PRQUEST_READY ';
export const NOTICE_PREFIX = 'PRQUEST_NOTICE ';
export const FATAL_PREFIX = 'PRQUEST_FATAL ';
export const SMOKE_DONE_PREFIX = 'PRQUEST_SMOKE_DONE ';
export const BOOTSTRAP_PREFIX = 'PRQUEST_BOOTSTRAP ';

/** 32 or more random bytes in base64url, which a cookie and a query string carry as they are. */
const Token = z.string().regex(/^[\w-]{43,}$/);

const LaunchSchema = z.object({
  requestSecret: Token,
  bootstrapCode: Token,
  /** The keychain's data key in base64, or null when the keychain can't be used. */
  dataKey: z
    .string()
    .refine((key) => Buffer.from(key, 'base64').length === DATA_KEY_BYTES)
    .nullable(),
  /** Where the sidecar remembers its port between runs, in the app's own data folder. */
  preferencesFile: z.string().min(1),
  /** Whether to ask the shell to show secrets notices; off when it restarts a crashed sidecar. */
  showNotices: z.boolean(),
});
export type Launch = z.infer<typeof LaunchSchema>;

const CommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('smoke') }),
  z.object({ command: z.literal('rebootstrap') }),
  z.object({ command: z.literal('notice'), action: z.enum(NOTICE_ACTIONS) }),
]);
export type Command = z.infer<typeof CommandSchema>;

export interface Ready {
  port: number;
  /** Where saved keys go; see `SecretsStorage`. */
  storage: string;
}

/** The launch message. Its errors never repeat what was sent, which holds the secrets. */
export function parseLaunch(line: string): Launch {
  const parsed = LaunchSchema.safeParse(safeParse(line));
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(message)');
    throw new Error(`The launch message on stdin is invalid: ${[...new Set(fields)].join(', ')}`);
  }
  return parsed.data;
}

export function parseCommand(line: string): Command | undefined {
  const parsed = CommandSchema.safeParse(safeParse(line));
  return parsed.success ? parsed.data : undefined;
}

export function readyLine(ready: Ready): string {
  return `${READY_PREFIX}${JSON.stringify(ready)}`;
}

export function noticeLine(notice: SecretsNotice): string {
  return `${NOTICE_PREFIX}${JSON.stringify(notice)}`;
}

/** A new one-time code for `BOOTSTRAP_PATH`, which the shell's window opens for its cookie. */
export function bootstrapLine(code: string): string {
  return `${BOOTSTRAP_PREFIX}${JSON.stringify({ code })}`;
}

/** Why the server couldn't start, which the shell shows in its error dialog. */
export function fatalLine(message: string): string {
  return `${FATAL_PREFIX}${JSON.stringify({ message })}`;
}

type Done = (error?: Error | null) => void;
type Stream = Pick<NodeJS.WriteStream, 'write'>;

/** Writes the protocol's lines to stdout. */
export interface ProtocolOutput {
  write: (text: string, done?: Done) => boolean;
}

/** Keeps `stdout` for the returned protocol writer, sending everything else written to it to `stderr`. */
export function takeStdoutForProtocol(
  stdout: Stream = process.stdout,
  stderr: Stream = process.stderr,
): ProtocolOutput {
  const write = stdout.write.bind(stdout);
  stdout.write = (chunk: string | Uint8Array, encoding?: BufferEncoding | Done, done?: Done) =>
    typeof encoding === 'function'
      ? stderr.write(chunk, encoding)
      : stderr.write(chunk, encoding, done);
  return { write: (text, written) => write(text, written) };
}

/**
 * Prints `line` and exits once it is written: `process.exit` drops what a pipe hasn't taken yet,
 * and the shell would then show a crash instead of the reason.
 */
export function exitAfterPrinting(
  line: string,
  code: number,
  stdout: { write: (text: string, done: () => void) => boolean },
  exit: (code: number) => void = (status) => process.exit(status),
): void {
  stdout.write(`${line}\n`, () => exit(code));
}

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
