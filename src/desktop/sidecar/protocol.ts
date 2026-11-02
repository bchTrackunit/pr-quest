import { z } from 'zod';

import { DATA_KEY_BYTES } from './dataKeyEncryptor.ts';

/*
 * The Tauri shell and this sidecar talk over stdio, which no other program can read:
 * - stdin, one JSON line each: first a `Launch`, then any `Command`s. Closing stdin, which happens
 *   when the shell quits or dies, stops the sidecar.
 * - stdout: `READY_PREFIX` and a `Ready` once the server listens, then smoke test lines. Logs go to
 *   stderr, so nothing a dependency prints can pass for one of these.
 */

export const READY_PREFIX = 'PRQUEST_READY ';
export const SMOKE_DONE_PREFIX = 'PRQUEST_SMOKE_DONE ';

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
});
export type Launch = z.infer<typeof LaunchSchema>;

const CommandSchema = z.object({ command: z.literal('smoke') });
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

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
