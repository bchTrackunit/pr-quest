import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const script = resolve(import.meta.dirname, 'collect-bundles.sh');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'collect-bundles-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Makes the bundle folder desktop-package would leave for `triple`, with these files. */
function bundles(triple: string, files: ReadonlyArray<string>): void {
  for (const file of files) {
    const path = join(dir, 'target', triple, 'release', 'bundle', file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file);
  }
}

function collect(triple: string, ...flags: Array<string>) {
  const out = join(dir, 'out');
  const result = spawnSync('bash', [script, triple, '1.2.0-beta.1', out, ...flags], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', CARGO_TARGET_DIR: join(dir, 'target') },
  });
  let files: Array<string> = [];
  try {
    files = readdirSync(out).sort();
  } catch {
    // Nothing collected.
  }
  return { status: result.status, stdout: result.stdout, files };
}

const v = '1.2.0-beta.1';

describe.skipIf(process.platform === 'win32')('collect-bundles.sh', () => {
  test('names the macOS update file after its processor', () => {
    bundles('aarch64-apple-darwin', [
      `dmg/PR Quest_${v}_aarch64.dmg`,
      'macos/PR Quest.app.tar.gz',
      'macos/PR Quest.app.tar.gz.sig',
      'dmg/bundle_dmg.sh',
      'pr-quest-build.txt',
    ]);

    const result = collect('aarch64-apple-darwin', '--updater');

    expect(result.status).toBe(0);
    expect(result.files).toEqual([
      `PR-Quest_${v}_aarch64.app.tar.gz`,
      `PR-Quest_${v}_aarch64.app.tar.gz.sig`,
      `PR-Quest_${v}_aarch64.dmg`,
      'build-aarch64-apple-darwin.txt',
    ]);
  });

  test('takes only the installers without --updater', () => {
    bundles('x86_64-apple-darwin', [`dmg/PR Quest_${v}_x64.dmg`]);
    bundles('x86_64-unknown-linux-gnu', [
      `appimage/PR Quest_${v}_amd64.AppImage`,
      `deb/PR Quest_${v}_amd64.deb`,
    ]);

    expect(collect('x86_64-apple-darwin').files).toEqual([`PR-Quest_${v}_x64.dmg`]);
    rmSync(join(dir, 'out'), { recursive: true });
    expect(collect('x86_64-unknown-linux-gnu').files).toEqual([
      `PR-Quest_${v}_amd64.AppImage`,
      `PR-Quest_${v}_amd64.deb`,
    ]);
  });

  test.each([
    [
      'aarch64-unknown-linux-gnu',
      [`appimage/PR Quest_${v}_aarch64.AppImage`, `deb/PR Quest_${v}_arm64.deb`],
      [
        `PR-Quest_${v}_aarch64.AppImage`,
        `PR-Quest_${v}_aarch64.AppImage.sig`,
        `PR-Quest_${v}_arm64.deb`,
        'build-aarch64-unknown-linux-gnu.txt',
      ],
    ],
    [
      'x86_64-pc-windows-msvc',
      [`nsis/PR Quest_${v}_x64-setup.exe`],
      [
        `PR-Quest_${v}_x64-setup.exe`,
        `PR-Quest_${v}_x64-setup.exe.sig`,
        'build-x86_64-pc-windows-msvc.txt',
      ],
    ],
  ])('collects %s with its update signature', (triple, installers, expected) => {
    bundles(triple, [...installers, `${installers[0] ?? ''}.sig`, 'pr-quest-build.txt']);

    const result = collect(triple, '--updater');

    expect(result.status).toBe(0);
    expect(result.files).toEqual(expected);
  });

  test('stops when a release build has no update signature', () => {
    bundles('x86_64-pc-windows-msvc', [`nsis/PR Quest_${v}_x64-setup.exe`]);

    const result = collect('x86_64-pc-windows-msvc', '--updater');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`has no nsis/PR Quest_${v}_x64-setup.exe.sig`);
  });

  test('stops when a release build has no build record', () => {
    bundles('x86_64-pc-windows-msvc', [
      `nsis/PR Quest_${v}_x64-setup.exe`,
      `nsis/PR Quest_${v}_x64-setup.exe.sig`,
    ]);

    const result = collect('x86_64-pc-windows-msvc', '--updater');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('has no ./pr-quest-build.txt');
  });

  test('stops when the bundle has another version', () => {
    bundles('x86_64-pc-windows-msvc', ['nsis/PR Quest_0.0.0_x64-setup.exe']);

    const result = collect('x86_64-pc-windows-msvc');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('nsis/PR Quest_0.0.0_x64-setup.exe');
  });

  test('stops for a platform PR Quest is not released for', () => {
    const result = collect('riscv64gc-unknown-linux-gnu');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("isn't released for riscv64gc-unknown-linux-gnu");
  });
});
