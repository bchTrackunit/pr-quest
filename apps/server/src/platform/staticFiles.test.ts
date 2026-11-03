import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createStaticHandler } from './staticFiles.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pr-quest-static-unit-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets', 'big-Ab12.js'), 'x'.repeat(1024 * 1024));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('createStaticHandler', () => {
  test('lets a client leave halfway through a file without an error', async () => {
    const req = new IncomingMessage(new Socket());
    req.method = 'GET';
    const res = new ServerResponse(req);
    res.destroy();

    await expect(createStaticHandler(root)(req, res, '/assets/big-Ab12.js')).resolves.toBe(true);
  });

  test('serves the build once it appears, after a request found no directory', async () => {
    const later = join(root, 'dist');
    const serve = createStaticHandler(later);
    const request = () => {
      const req = new IncomingMessage(new Socket());
      req.method = 'GET';
      const res = new ServerResponse(req);
      res.destroy();
      return serve(req, res, '/');
    };
    await expect(request()).rejects.toThrow(/ENOENT/);

    await mkdir(later);
    await writeFile(join(later, 'index.html'), '<!doctype html>');

    await expect(request()).resolves.toBe(true);
  });
});
