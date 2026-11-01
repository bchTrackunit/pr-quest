import { createWriteStream, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, extname } from 'node:path';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export interface LogFile {
  info: (message: string) => void;
  warn: (message: string) => void;
  close: () => Promise<void>;
}

export interface LogFileOptions {
  /** Also write each line to stdout or stderr, for `yarn desktop:dev` in a terminal. */
  echo: boolean;
  /** A file this large at startup becomes `<name>.old<ext>` and a new one starts. */
  maxBytes?: number;
}

/**
 * The main process's log, since a packaged app has no terminal. It gets what the server logs,
 * which never includes tokens or keys.
 */
export function openLogFile(file: string, options: LogFileOptions): LogFile {
  mkdirSync(dirname(file), { recursive: true });
  rotate(file, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const stream = createWriteStream(file, { flags: 'a', mode: 0o600 });
  let closed = false;
  const write = (level: 'INFO' | 'WARN', message: string): void => {
    // Writing to an ended stream throws asynchronously, and the server may still log while quitting.
    if (!closed) {
      stream.write(`${new Date().toISOString()} ${level} ${message}\n`);
    }
    if (options.echo) {
      (level === 'WARN' ? process.stderr : process.stdout).write(`[pr-quest] ${message}\n`);
    }
  };
  return {
    info: (message) => {
      write('INFO', message);
    },
    warn: (message) => {
      write('WARN', message);
    },
    close: () =>
      new Promise((resolve) => {
        closed = true;
        stream.end(resolve);
      }),
  };
}

function rotate(file: string, maxBytes: number): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size > maxBytes) {
    const ext = extname(file);
    renameSync(file, `${file.slice(0, file.length - ext.length)}.old${ext}`);
  }
}
