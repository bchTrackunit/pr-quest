import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const script = resolve(import.meta.dirname, 'compiled.sh');
const triple = 'aarch64-apple-darwin';
const release = `apps/desktop/src-tauri/target/${triple}/release`;
const sidecar = 'apps/desktop/build-tauri/sidecar';

let dir: string;
/** The checkout that compiles, and the fresh one that bundles. */
let compiling: string;
let bundling: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'compiled-'));
  compiling = join(dir, 'compiling');
  bundling = join(dir, 'bundling');
  mkdirSync(bundling);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [file, contents] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
}

/** What `package.sh --compile-only` leaves, with what bundling doesn't need next to it. */
function compile(): void {
  write(compiling, {
    [`${release}/pr-quest`]: 'shell',
    [`${release}/deps/pr_quest-1.o`]: 'object',
    [`${sidecar}/main.mjs`]: 'server',
    [`${sidecar}/dist/index.html`]: '<html>',
    [`${sidecar}/dist/assets/index-AbC_1-2.js`]: 'ui',
    [`${sidecar}/node_modules/@cursor/sdk/index.js`]: 'sdk',
    [`${sidecar}/package.json`]: '{"type":"module"}',
    'apps/desktop/src-tauri/binaries/pr-quest-node-aarch64-apple-darwin': 'node',
  });
}

function run(cwd: string, mode: string, folder = join(dir, 'artifact')) {
  const result = spawnSync('bash', [script, mode, triple, folder], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
  return { status: result.status, stdout: result.stdout };
}

/** Writes compiled.tar from `root` with these tar arguments. */
function tar(root: string, ...names: Array<string>): void {
  const result = spawnSync('tar', ['-cf', join(dir, 'artifact', 'compiled.tar'), ...names], {
    cwd: root,
  });
  expect(result.status).toBe(0);
}

/**
 * Writes compiled.tar with these files under exactly these names, which tar itself would clean up
 * (GNU tar drops `..` and a leading `/` from what it archives).
 */
function rawTar(files: Record<string, string>): void {
  const blocks: Array<Buffer> = [];
  for (const [name, contents] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${contents.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write(' '.repeat(8), 148);
    header.write('0', 156);
    header.write('ustar\u000000', 257);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    const body = Buffer.alloc(Math.ceil(contents.length / 512) * 512);
    body.write(contents);
    blocks.push(header, body);
  }
  writeFileSync(
    join(dir, 'artifact', 'compiled.tar'),
    Buffer.concat([...blocks, Buffer.alloc(1024)]),
  );
}

describe.skipIf(process.platform === 'win32')('compiled.sh', () => {
  test('carries only the shell, main.mjs and dist/ into a fresh checkout', () => {
    compile();

    expect(run(compiling, 'pack')).toMatchObject({
      status: 0,
      stdout: 'Packed 4 files for aarch64-apple-darwin.\n',
    });
    expect(readFileSync(join(dir, 'artifact', 'MANIFEST.sha256'), 'utf8')).toMatch(
      /^[0-9a-f]{64} {2}pr-quest\n[0-9a-f]{64} {2}sidecar\/dist\/assets\/index-AbC_1-2\.js\n[0-9a-f]{64} {2}sidecar\/dist\/index\.html\n[0-9a-f]{64} {2}sidecar\/main\.mjs\n$/,
    );
    expect(run(bundling, 'unpack').status).toBe(0);

    expect(readFileSync(join(bundling, release, 'pr-quest'), 'utf8')).toBe('shell');
    expect(statSync(join(bundling, release, 'pr-quest')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(bundling, sidecar, 'dist/assets/index-AbC_1-2.js'), 'utf8')).toBe(
      'ui',
    );
    expect(existsSync(join(bundling, release, 'deps'))).toBe(false);
    expect(existsSync(join(bundling, sidecar, 'node_modules'))).toBe(false);
    expect(existsSync(join(bundling, sidecar, 'package.json'))).toBe(false);
    expect(existsSync(join(bundling, 'apps/desktop/src-tauri/binaries'))).toBe(false);
    expect(run(bundling, 'check-unbuilt').status).toBe(0);
  });

  test('stops when the tar differs from its manifest', () => {
    compile();
    expect(run(compiling, 'pack').status).toBe(0);
    write(compiling, { [`${sidecar}/main.mjs`]: 'planted' });
    write(join(dir, 'staging'), { 'pr-quest': 'shell', 'sidecar/main.mjs': 'planted' });
    tar(join(dir, 'staging'), 'pr-quest', 'sidecar');

    const result = run(bundling, 'unpack');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("compiled.tar doesn't match MANIFEST.sha256");
    expect(existsSync(join(bundling, 'apps'))).toBe(false);
  });

  test.each([
    [
      'a file it has no business with',
      { 'scripts/ci/package.sh': 'planted' },
      'holds scripts/ci/package.sh',
    ],
    ['a package', { 'sidecar/node_modules/x/index.js': 'planted' }, 'holds sidecar/node_modules/'],
    [
      'a path out of its folder',
      { 'sidecar/dist/../../x': 'planted' },
      'holds sidecar/dist/../../x',
    ],
    // GNU tar lists it without the leading slash, bsdtar with it.
    ['an absolute path', { '/tmp/x': 'planted' }, 'tmp/x, which'],
  ])('stops when the tar holds %s', (_, files, message) => {
    compile();
    expect(run(compiling, 'pack').status).toBe(0);
    rawTar({ 'pr-quest': 'shell', ...files });

    const result = run(bundling, 'unpack');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(message);
  });

  test('stops when the tar holds a link', () => {
    compile();
    expect(run(compiling, 'pack').status).toBe(0);
    write(join(dir, 'staging'), { 'pr-quest': 'shell' });
    mkdirSync(join(dir, 'staging', 'sidecar'));
    symlinkSync('/etc', join(dir, 'staging', 'sidecar', 'dist'));
    tar(join(dir, 'staging'), 'pr-quest', 'sidecar');

    const result = run(bundling, 'unpack');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('entries other than files and folders');
  });

  test('stops when the checkout has compiled already', () => {
    compile();
    expect(run(compiling, 'pack').status).toBe(0);
    write(bundling, { [`${release}/pr-quest`]: 'stale' });

    const result = run(bundling, 'unpack');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('exists already; unpack into a fresh checkout');
  });

  test.each([
    [`${release}/.fingerprint/pr-quest-1/lib`, 'cargo built something'],
    ['apps/web/dist/index.html', 'yarn build ran'],
    [`${sidecar}/main.mjs`, 'something rebuilt the sidecar'],
  ])('check-unbuilt stops when the bundle job made %s', (file, message) => {
    compile();
    expect(run(compiling, 'pack').status).toBe(0);
    expect(run(bundling, 'unpack').status).toBe(0);
    write(bundling, { [file]: 'built' });

    const result = run(bundling, 'check-unbuilt');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(message);
  });
});
