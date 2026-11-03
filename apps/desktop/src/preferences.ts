import { dirname } from 'node:path';
import { z } from 'zod';

import {
  ensurePrivateDir,
  readIfExists,
  safeJson,
  writePrivateJson,
} from '@pr-quest/server/privateFiles';

/** What the desktop app remembers between runs, apart from the player's state. */
export interface DesktopPreferences {
  /** The server's last port. */
  port?: number;
  /** Without a keychain: whether the player chose to save keys unencrypted, once they've chosen. */
  plaintextSecrets?: boolean;
}

const PreferencesFileSchema = z.object({
  version: z.literal(1),
  port: z.number().int().min(1).max(65535).optional(),
  plaintextSecrets: z.boolean().optional(),
});

/**
 * The saved preferences. An unreadable or newer file counts as none, which at worst asks the
 * keychain question again.
 */
export async function readPreferences(file: string): Promise<DesktopPreferences> {
  const parsed = PreferencesFileSchema.safeParse(safeJson((await readIfExists(file)) ?? ''));
  if (!parsed.success) {
    return {};
  }
  const { version: _version, ...preferences } = parsed.data;
  return preferences;
}

export async function writePreferences(
  file: string,
  preferences: DesktopPreferences,
): Promise<void> {
  await ensurePrivateDir(dirname(file));
  await writePrivateJson(file, { version: 1, ...preferences });
}
