import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const script = resolve(import.meta.dirname, 'artifact-hashes.sh');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'artifact-hashes-'));
  write('release-files/mac-arm64', {
    'PR-Quest_1.0.0_aarch64.dmg': 'dmg',
    'PR-Quest_1.0.0_aarch64.app.tar.gz': 'update',
    'build-aarch64-apple-darwin.txt': 'signed=true',
  });
  write('release-files/win-x64', { 'PR-Quest_1.0.0_x64-setup.exe': 'installer' });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(folder: string, files: Record<string, string>): void {
  mkdirSync(join(dir, folder), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, folder, name), contents);
  }
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function run(args: ReadonlyArray<string>, env: Record<string, string> = {}) {
  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  return { status: result.status, stdout: result.stdout };
}

/** What the bundle jobs of both targets would put in their outputs. */
function lists(): Record<string, string> {
  const listed: Record<string, string> = {};
  for (const id of ['mac-arm64', 'win-x64']) {
    const result = run(['list', join(dir, 'release-files', id), `desktop-${id}`]);
    expect(result.status).toBe(0);
    listed[`BUNDLED_SHA256_${id.replace('-', '_').toUpperCase()}`] = result.stdout;
  }
  return listed;
}

/** Downloads what the bundle jobs uploaded, as download-artifact lays it out. */
function download(): string {
  for (const id of ['mac-arm64', 'win-x64']) {
    spawnSync('cp', [
      '-R',
      join(dir, 'release-files', id),
      join(dir, 'artifacts', `desktop-${id}`),
    ]);
  }
  return join(dir, 'artifacts');
}

describe.skipIf(process.platform === 'win32')('artifact-hashes.sh', () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'artifacts'));
  });

  test('lists every file with its SHA-256, sorted, under the artifact name', () => {
    const result = run(['list', join(dir, 'release-files', 'mac-arm64'), 'desktop-mac-arm64']);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `${sha256('update')}  desktop-mac-arm64/PR-Quest_1.0.0_aarch64.app.tar.gz\n` +
        `${sha256('dmg')}  desktop-mac-arm64/PR-Quest_1.0.0_aarch64.dmg\n` +
        `${sha256('signed=true')}  desktop-mac-arm64/build-aarch64-apple-darwin.txt\n`,
    );
  });

  test('accepts exactly the files the bundle jobs listed', () => {
    const result = run(['check', download()], lists());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('The 4 downloaded files are the ones the bundle jobs checked');
  });

  test.each([
    [
      'a changed file',
      () => writeFileSync(join(dir, 'artifacts/desktop-win-x64/PR-Quest_1.0.0_x64-setup.exe'), 'x'),
      'Changed since its bundle job checked it: desktop-win-x64/PR-Quest_1.0.0_x64-setup.exe',
    ],
    [
      'a missing file',
      () => rmSync(join(dir, 'artifacts/desktop-mac-arm64/PR-Quest_1.0.0_aarch64.dmg')),
      'Missing: desktop-mac-arm64/PR-Quest_1.0.0_aarch64.dmg',
    ],
    [
      'an extra file',
      () => writeFileSync(join(dir, 'artifacts/desktop-win-x64/extra.exe'), 'x'),
      'No bundle job checked: desktop-win-x64/extra.exe',
    ],
    [
      'an extra artifact',
      () => write('artifacts/desktop-other', { 'PR-Quest_1.0.0_x64-setup.exe': 'installer' }),
      'No bundle job checked: desktop-other/PR-Quest_1.0.0_x64-setup.exe',
    ],
    [
      'a file moved to another artifact',
      () =>
        spawnSync('mv', [
          join(dir, 'artifacts/desktop-win-x64/PR-Quest_1.0.0_x64-setup.exe'),
          join(dir, 'artifacts/desktop-mac-arm64/'),
        ]),
      'Missing: desktop-win-x64/PR-Quest_1.0.0_x64-setup.exe',
    ],
  ])('stops at %s', (_, change, message) => {
    const listed = lists();
    download();
    change();

    const result = run(['check', join(dir, 'artifacts')], listed);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(message);
    expect(result.stdout).toContain("aren't the ones the bundle jobs checked");
  });

  test('stops when a bundle job set no SHA-256s', () => {
    const result = run(['check', download()], { ...lists(), BUNDLED_SHA256_WIN_X64: '' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('BUNDLED_SHA256_WIN_X64 is empty');
  });

  test('stops when no bundle job is named', () => {
    const result = run(['check', download()]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('No BUNDLED_SHA256_* variable');
  });

  test('stops at a list that is not one', () => {
    const result = run(['check', download()], { ...lists(), BUNDLED_SHA256_WIN_X64: '***' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("BUNDLED_SHA256_WIN_X64 has a line that isn't");
  });

  test.each([
    ['a link', () => symlinkSync('/etc/hosts', join(dir, 'artifacts/desktop-win-x64/hosts'))],
    ['a folder in an artifact', () => mkdirSync(join(dir, 'artifacts/desktop-win-x64/sub'))],
    ['a file beside the artifacts', () => writeFileSync(join(dir, 'artifacts/stray'), 'x')],
  ])('stops at %s', (_, change) => {
    const listed = lists();
    download();
    change();

    const result = run(['check', join(dir, 'artifacts')], listed);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/isn't a file|isn't an artifact's folder/);
  });

  test('refuses to list an empty folder', () => {
    mkdirSync(join(dir, 'empty'));

    expect(run(['list', join(dir, 'empty'), 'desktop-x']).stdout).toContain('is empty');
  });
});
