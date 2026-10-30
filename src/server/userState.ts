import { chmod, copyFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { ensurePrivateDir } from './privateFiles.ts';

/** GitHub logins are letters, digits and hyphens, never starting with a hyphen, at most 39 long. */
const LOGIN_PATTERN = /^[a-z\d][a-z\d-]{0,38}$/i;

/** Files that used to be shared by everyone and now live in each user's folder. */
const LEGACY_FILES = ['state.json', 'quests.json'] as const;

/** `<stateDir>/users/<login>`: one player's game state and quest cache. */
export function userStateDir(stateDir: string, login: string): string {
  if (!LOGIN_PATTERN.test(login)) {
    throw new Error(`Not a GitHub login: ${JSON.stringify(login.slice(0, 50))}`);
  }
  return join(stateDir, 'users', login.toLowerCase());
}

export interface MigrateOptions {
  now?: () => Date;
}

/**
 * Hands the state from before per-user folders to the first user who shows up. Each file is copied
 * into their folder, then the original is renamed to a `.bak` that nothing reads, so it can't be
 * handed to a second user. A user who already has state keeps it.
 */
export async function migrateLegacyState(
  stateDir: string,
  login: string,
  options: MigrateOptions = {},
): Promise<{ migrated: Array<string> }> {
  const userDir = userStateDir(stateDir, login);
  await ensurePrivateDir(join(stateDir, 'users'));
  await ensurePrivateDir(userDir);
  if (await exists(join(userDir, 'state.json'))) {
    return { migrated: [] };
  }
  const stamp = (options.now ?? (() => new Date()))()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+/, '');
  const migrated: Array<string> = [];
  for (const name of LEGACY_FILES) {
    const legacy = join(stateDir, name);
    const target = join(userDir, name);
    if (!(await exists(legacy)) || (await exists(target))) {
      continue;
    }
    const temp = `${target}.${process.pid}.migrating`;
    await copyFile(legacy, temp);
    await chmod(temp, 0o600);
    await rename(temp, target);
    await rename(legacy, `${legacy}.migrated-to-${login.toLowerCase()}-${stamp}.bak`);
    migrated.push(name);
  }
  return { migrated };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
