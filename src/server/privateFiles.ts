import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** Creates `dir` if needed and makes sure only the current user can open it. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // `mkdir` leaves an existing directory's mode alone.
  await chmod(dir, PRIVATE_DIR_MODE);
}

/**
 * Writes JSON through a synced temp file and a rename, so readers never see a half-written file and
 * a power loss can't leave an empty one. A failed write removes the temp copy.
 */
export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Throws when `parsed` carries a `version` above `supported`: a newer build wrote it. */
export function refuseNewerVersion(parsed: unknown, supported: number, file: string): void {
  const version =
    typeof parsed === 'object' && parsed !== null && 'version' in parsed ? parsed.version : undefined;
  if (typeof version === 'number' && version > supported) {
    throw new Error(
      `${file} was written by a newer version of PR Quest (file version ${version}, this build reads version ${supported}). Update PR Quest, or move the file away to start fresh.`,
    );
  }
}

/** The file's text, or `undefined` when it doesn't exist. */
export async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Serializes async writes so each one sees the result of the one before. */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();

  public run<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    const next = this.tail.then(task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
