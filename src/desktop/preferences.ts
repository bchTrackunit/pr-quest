import { dirname } from 'node:path';
import { z } from 'zod';

import {
  ensurePrivateDir,
  readIfExists,
  safeJson,
  writePrivateJson,
} from '../platform/server/privateFiles.ts';

/** What the desktop app remembers between runs, apart from the player's state. */
export interface DesktopPreferences {
  /** The server's last port. */
  port?: number;
}

const PreferencesFileSchema = z.object({
  version: z.literal(1),
  port: z.number().int().min(1).max(65535).optional(),
});

/** The saved preferences; an unreadable or newer file counts as none, since they are only hints. */
export async function readPreferences(file: string): Promise<DesktopPreferences> {
  const parsed = PreferencesFileSchema.safeParse(safeJson((await readIfExists(file)) ?? ''));
  return parsed.success && parsed.data.port !== undefined ? { port: parsed.data.port } : {};
}

export async function writePreferences(
  file: string,
  preferences: DesktopPreferences,
): Promise<void> {
  await ensurePrivateDir(dirname(file));
  await writePrivateJson(file, { version: 1, ...preferences });
}
