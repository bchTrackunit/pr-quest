import { chmod, copyFile, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensurePrivateDir, readIfExists, WriteQueue } from './privateFiles.ts';

/** GitHub logins are letters, digits and hyphens, never starting with a hyphen, at most 39 long. */
const LOGIN_PATTERN = /^[a-z\d][a-z\d-]{0,38}$/i;

/**
 * Files that used to be shared by everyone and now live in each user's folder. `state.json` goes
 * last: once a user has it, everything before it has been handed over too.
 */
const LEGACY_FILES = ['quests.json', 'state.json'] as const;

/** `users/.legacy-owner`: the login that received the shared state. Nobody else ever gets it. */
const OWNER_FILE = '.legacy-owner';

/** The backups of a migration that ran before the owner was recorded name the owner. */
const BACKUP_PATTERN = /^(?:state|quests)\.json\.migrated-to-([a-z\d][a-z\d-]{0,38})-\d{8}T\d{6}Z\.bak$/;

/** One migration at a time, so two users signing in at once can't both copy the shared state. */
const migrations = new WriteQueue();

/** `<stateDir>/users/<login>`: one player's game state and quest cache. */
export function userStateDir(stateDir: string, login: string): string {
  if (!LOGIN_PATTERN.test(login)) {
    throw new Error(`Not a GitHub login: ${JSON.stringify(login.slice(0, 50))}`);
  }
  return join(stateDir, 'users', login.toLowerCase());
}

export interface MigrateOptions {
  now?: () => Date;
  onWarning?: (message: string) => void;
}

/**
 * Hands the state from before per-user folders to the first user who shows up. Each file is copied
 * into their folder, then the original is renamed to a timestamped `.bak` that nothing reads, so it
 * can't be handed to a second user. The receiving login is recorded, and a shared file that
 * reappears later (say, from running an older build) is renamed to `.orphaned-<stamp>.bak` instead
 * of being given to anyone. A user who already has state keeps it. Running it again is a no-op, and
 * a run that stopped between the copy and the rename is finished.
 */
export async function migrateLegacyState(
  stateDir: string,
  login: string,
  options: MigrateOptions = {},
): Promise<{ migrated: Array<string> }> {
  const userDir = userStateDir(stateDir, login);
  return await migrations.run(() => migrate(stateDir, userDir, login.toLowerCase(), options));
}

async function migrate(
  stateDir: string,
  userDir: string,
  login: string,
  options: MigrateOptions,
): Promise<{ migrated: Array<string> }> {
  const usersDir = join(stateDir, 'users');
  await ensurePrivateDir(usersDir);
  await ensurePrivateDir(userDir);
  const ownerFile = join(usersDir, OWNER_FILE);
  const recorded = (await readIfExists(ownerFile))?.trim().toLowerCase();
  const owner = recorded && LOGIN_PATTERN.test(recorded) ? recorded : await ownerFromBackups(stateDir);
  const hasState = await exists(join(userDir, 'state.json'));
  const stamp = timestamp((options.now ?? (() => new Date()))());
  const migrated: Array<string> = [];
  for (const name of LEGACY_FILES) {
    const legacy = join(stateDir, name);
    const target = join(userDir, name);
    if (!(await exists(legacy))) {
      continue;
    }
    const targetExists = await exists(target);
    if ((owner === undefined || owner === login) && targetExists && (await sameContent(legacy, target))) {
      await rename(legacy, `${legacy}.migrated-to-${login}-${stamp}.bak`);
      migrated.push(name);
    } else if (owner !== undefined) {
      const orphan = await setAside(legacy, stamp);
      options.onWarning?.(
        `${name} reappeared after the shared state went to ${owner}; it was moved to ${orphan} and given to nobody`,
      );
    } else if (!targetExists && !hasState) {
      const temp = `${target}.${process.pid}.migrating`;
      await copyFile(legacy, temp);
      await chmod(temp, 0o600);
      await rename(temp, target);
      await rename(legacy, `${legacy}.migrated-to-${login}-${stamp}.bak`);
      migrated.push(name);
    }
  }
  const receiver = owner ?? (migrated.length > 0 ? login : undefined);
  if (receiver !== undefined && receiver !== recorded) {
    await writeFile(ownerFile, `${receiver}\n`, { mode: 0o600 });
  }
  return { migrated };
}

async function ownerFromBackups(stateDir: string): Promise<string | undefined> {
  for (const name of (await readdir(stateDir)).sort()) {
    const login = BACKUP_PATTERN.exec(name)?.[1];
    if (login) {
      return login;
    }
  }
  return undefined;
}

/** Renames `file` to `<file>.orphaned-<stamp>.bak`, numbering it if that name is taken. */
async function setAside(file: string, stamp: string): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    const name = `${file}.orphaned-${stamp}${attempt === 0 ? '' : `-${attempt}`}.bak`;
    if (!(await exists(name))) {
      await rename(file, name);
      return name;
    }
  }
}

function timestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+/, '');
}

async function sameContent(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([readFile(a), readFile(b)]);
  return left.equals(right);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
