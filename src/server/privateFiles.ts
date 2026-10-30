import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** Creates `dir` if needed and makes sure only the current user can open it. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // `mkdir` leaves an existing directory's mode alone.
  await chmod(dir, PRIVATE_DIR_MODE);
}

/** Writes JSON through a temp file and a rename, so readers never see a half-written file. */
export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
  await rename(temp, file);
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
