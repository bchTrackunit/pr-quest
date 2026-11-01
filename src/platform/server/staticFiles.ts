import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

/** Vite gives every file it writes here a content hash in its name, so a changed file is a new URL. */
const HASHED_DIR = 'assets/';
const IMMUTABLE = 'public, max-age=31536000, immutable';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/** Writes the file for `pathname`, or answers `false` when there is none to send. */
export type StaticHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
) => Promise<boolean>;

/**
 * Serves the built UI in `root`. A path without a file extension that names no file gets
 * `index.html`, so the single-page app can own its URLs; a missing asset is a 404 rather than HTML
 * that a browser would cache as the asset. Dotfiles and paths outside `root` are never served.
 */
export function createStaticHandler(root: string): StaticHandler {
  const base = resolve(root);
  return async (req, res, pathname) => {
    const requested = relativePath(pathname);
    if (requested === undefined) {
      return false;
    }
    let path = requested;
    let file = path === '' ? undefined : await fileAt(base, path);
    if (!file && extname(path) === '') {
      path = 'index.html';
      file = await fileAt(base, path);
    }
    if (!file) {
      return false;
    }
    await sendFile(req, res, file, path);
    return true;
  };
}

interface StaticFile {
  path: string;
  size: number;
}

/** The `/`-separated path below the root, or `undefined` for anything that could leave it. */
function relativePath(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    return undefined;
  }
  const segments = decoded.split('/').filter((segment) => segment !== '');
  // Also refuses `.` and `..`, so the path can't climb out of the root.
  if (segments.some((segment) => segment.startsWith('.'))) {
    return undefined;
  }
  return segments.join('/');
}

async function fileAt(base: string, path: string): Promise<StaticFile | undefined> {
  const full = join(base, path);
  if (!full.startsWith(base + sep)) {
    return undefined;
  }
  try {
    const stats = await stat(full);
    return stats.isFile() ? { path: full, size: stats.size } : undefined;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      ['ENOENT', 'ENOTDIR'].includes(String(error.code))
    ) {
      return undefined;
    }
    throw error;
  }
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: StaticFile,
  path: string,
): Promise<void> {
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': String(file.size),
    'Cache-Control': path.startsWith(HASHED_DIR) ? IMMUTABLE : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...(contentType.startsWith('text/html') ? { 'X-Frame-Options': 'DENY' } : {}),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(createReadStream(file.path), res);
}
