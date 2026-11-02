import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const script = resolve(import.meta.dirname, '../../scripts/collect-release-assets.sh');
const hasYq = spawnSync('yq', ['--version']).status === 0;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'collect-release-assets-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sha512(content: string): string {
  return createHash('sha512').update(content).digest('base64');
}

/** One build job's artifact: an installer and the update file electron-builder wrote for it. */
function job(
  name: string,
  updateFile: string,
  installer: string,
  content: string,
  entry: { sha512?: string; size?: number } = {},
): void {
  const folder = join(dir, 'artifacts', name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, installer), content);
  const hash = entry.sha512 ?? sha512(content);
  writeFileSync(
    join(folder, updateFile),
    `version: 1.0.0
files:
  - url: ${installer}
    sha512: ${hash}
    size: ${String(entry.size ?? Buffer.byteLength(content))}
path: ${installer}
sha512: ${hash}
releaseDate: '2026-11-01T00:00:00.000Z'
`,
  );
}

function collect() {
  const result = spawnSync('bash', [script, join(dir, 'artifacts'), join(dir, 'assets')], {
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout };
}

describe.skipIf(process.platform === 'win32' || !hasYq)('collect-release-assets.sh', () => {
  test('merges the macOS update files and keeps the rest', () => {
    job('desktop-mac-arm64', 'latest-mac.yml', 'pr-quest-1.0.0-mac-arm64.zip', 'arm64 zip');
    job('desktop-mac-x64', 'latest-mac.yml', 'pr-quest-1.0.0-mac-x64.zip', 'x64 zip');
    job(
      'desktop-linux-x64',
      'latest-linux.yml',
      'pr-quest-1.0.0-linux-x86_64.AppImage',
      'appimage',
    );

    const result = collect();

    expect(result.status).toBe(0);
    const merged = readFileSync(join(dir, 'assets', 'latest-mac.yml'), 'utf8');
    expect(merged).toContain('pr-quest-1.0.0-mac-arm64.zip');
    expect(merged).toContain('pr-quest-1.0.0-mac-x64.zip');
    expect(readFileSync(join(dir, 'assets', 'latest-linux.yml'), 'utf8')).toContain('AppImage');
  });

  test.each([
    ['gives a file another size', { size: 3 }, 'size of 3 bytes'],
    ['gives a file another sha512', { sha512: sha512('something else') }, 'sha512'],
  ])('stops when an update file %s than the installer has', (_case, entry, message) => {
    job(
      'desktop-linux-x64',
      'latest-linux.yml',
      'pr-quest-1.0.0-linux-x86_64.AppImage',
      'appimage',
      entry,
    );

    const result = collect();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(message);
  });

  test('stops when an update file names an installer no job produced', () => {
    job(
      'desktop-linux-x64',
      'latest-linux.yml',
      'pr-quest-1.0.0-linux-x86_64.AppImage',
      'appimage',
    );
    rmSync(join(dir, 'artifacts', 'desktop-linux-x64', 'pr-quest-1.0.0-linux-x86_64.AppImage'));

    const result = collect();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('no build job produced');
  });

  test('stops when two jobs produce the same file', () => {
    job(
      'desktop-linux-x64',
      'latest-linux.yml',
      'pr-quest-1.0.0-linux-x86_64.AppImage',
      'appimage',
    );
    job(
      'desktop-linux-x64-again',
      'latest-linux.yml',
      'pr-quest-1.0.0-linux-x86_64.AppImage',
      'appimage',
    );

    const result = collect();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('More than one build job');
  });
});
