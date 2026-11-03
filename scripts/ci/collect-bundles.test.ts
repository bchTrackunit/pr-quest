import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

const APP = 'macos/PR Quest.app/Contents';

describe.skipIf(process.platform === 'win32')('collect-bundles.sh', () => {
  test('makes the macOS update file from the app, named after its processor', () => {
    bundles('aarch64-apple-darwin', [
      `dmg/PR Quest_${v}_aarch64.dmg`,
      `${APP}/MacOS/pr-quest`,
      `${APP}/Resources/sidecar/server.js`,
      'dmg/bundle_dmg.sh',
      'pr-quest-build.txt',
    ]);
    symlinkSync(
      'server.js',
      join(dir, 'target/aarch64-apple-darwin/release/bundle', APP, 'Resources/sidecar/link.js'),
    );

    const result = collect('aarch64-apple-darwin', '--updater');

    expect(result.status).toBe(0);
    expect(result.files).toEqual([
      `PR-Quest_${v}_aarch64.app.tar.gz`,
      `PR-Quest_${v}_aarch64.dmg`,
      'build-aarch64-apple-darwin.txt',
    ]);
    // What tauri-plugin-updater unpacks: one folder, the app, with its links as links.
    const listing = spawnSync(
      'tar',
      ['-tvzf', join(dir, 'out', `PR-Quest_${v}_aarch64.app.tar.gz`)],
      {
        encoding: 'utf8',
      },
    ).stdout;
    const names = listing
      .trim()
      .split('\n')
      .map((line) => /(PR Quest\.app.*?)(?: -> .*)?$/.exec(line)?.[1]?.replace(/\/$/, '') ?? '');
    expect(names.sort()).toEqual([
      'PR Quest.app',
      'PR Quest.app/Contents',
      'PR Quest.app/Contents/MacOS',
      'PR Quest.app/Contents/MacOS/pr-quest',
      'PR Quest.app/Contents/Resources',
      'PR Quest.app/Contents/Resources/sidecar',
      'PR Quest.app/Contents/Resources/sidecar/link.js',
      'PR Quest.app/Contents/Resources/sidecar/server.js',
    ]);
    expect(listing).toMatch(/^l.*link\.js -> server\.js$/m);
  });

  test('stops when a macOS release build has no app to make the update file from', () => {
    bundles('x86_64-apple-darwin', [`dmg/PR Quest_${v}_x64.dmg`, 'pr-quest-build.txt']);

    const result = collect('x86_64-apple-darwin', '--updater');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('has no macos/PR Quest.app');
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
        `PR-Quest_${v}_arm64.deb`,
        'build-aarch64-unknown-linux-gnu.txt',
      ],
    ],
    [
      'x86_64-pc-windows-msvc',
      [`nsis/PR Quest_${v}_x64-setup.exe`],
      [`PR-Quest_${v}_x64-setup.exe`, 'build-x86_64-pc-windows-msvc.txt'],
    ],
  ])(
    'collects %s with its build record, and no update signature',
    (triple, installers, expected) => {
      // A signature desktop-package made with a local key isn't the release's.
      bundles(triple, [...installers, `${installers[0] ?? ''}.sig`, 'pr-quest-build.txt']);

      const result = collect(triple, '--updater');

      expect(result.status).toBe(0);
      expect(result.files).toEqual(expected);
    },
  );

  test('stops when a release build has no build record', () => {
    bundles('x86_64-pc-windows-msvc', [`nsis/PR Quest_${v}_x64-setup.exe`]);

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
