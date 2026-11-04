import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const script = resolve(import.meta.dirname, 'smoke.sh');

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-')));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'tmp'));
  // Records each `just desktop-smoke <artifact> <flags>`, with the bundle, release files or
  // unpacking folder taken off, and whether the artifact was there.
  writeFileSync(
    join(dir, 'bin', 'just'),
    `#!/bin/sh
[ -e "$2" ] || missing=" (missing)"
echo "$*$missing" | sed -e "s|$BUNDLES/||" -e "s|$STUB_DIR/files/||" -e "s|$TMPDIR/[^/]*/|unpacked/|" >>"$STUB_DIR/smoked"
exit "\${STUB_JUST_STATUS:-0}"
`,
  );
  chmodSync(join(dir, 'bin', 'just'), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function bundles(triple: string, files: ReadonlyArray<string>): void {
  for (const file of files) {
    const path = join(dir, 'target', triple, 'release', 'bundle', file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
  }
}

/** The release files, as collect-bundles.sh names them and an artifact download leaves them. */
function releaseFiles(files: Record<string, string>): void {
  mkdirSync(join(dir, 'files'));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, 'files', name), contents, { mode: 0o644 });
  }
}

/** A macOS update archive with "PR Quest.app" at its root. */
function updateArchive(name: string): void {
  mkdirSync(join(dir, 'app', 'PR Quest.app', 'Contents'), { recursive: true });
  writeFileSync(join(dir, 'app', 'PR Quest.app', 'Contents', 'Info.plist'), '');
  const result = spawnSync('tar', [
    '-czf',
    join(dir, 'files', name),
    '-C',
    join(dir, 'app'),
    'PR Quest.app',
  ]);
  expect(result.status).toBe(0);
}

function smoke(triple: string, env: Record<string, string> = {}, files?: string) {
  const result = spawnSync('bash', [script, triple, ...(files === undefined ? [] : [files])], {
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      CARGO_TARGET_DIR: join(dir, 'target'),
      BUNDLES: join(dir, 'target', triple, 'release', 'bundle'),
      STUB_DIR: dir,
      TMPDIR: join(dir, 'tmp'),
      ...env,
    },
  });
  const smoked = existsSync(join(dir, 'smoked')) ? readFileSync(join(dir, 'smoked'), 'utf8') : '';
  return { status: result.status, stdout: result.stdout, smoked };
}

describe.skipIf(process.platform === 'win32')('smoke.sh', () => {
  test('smoke-tests the macOS app and the app in the dmg', () => {
    bundles('aarch64-apple-darwin', [
      'macos/PR Quest.app/Contents/Info.plist',
      'dmg/PR Quest_1.0.0_aarch64.dmg',
    ]);
    const result = smoke('aarch64-apple-darwin');

    expect(result.status).toBe(0);
    expect(result.smoked).toBe(
      'desktop-smoke macos/PR Quest.app --target aarch64-apple-darwin\n' +
        'desktop-smoke dmg/PR Quest_1.0.0_aarch64.dmg --target aarch64-apple-darwin\n',
    );
  });

  test('smoke-tests the AppImage and the deb headless on Linux', () => {
    bundles('x86_64-unknown-linux-gnu', [
      'appimage/PR Quest_1.0.0_amd64.AppImage',
      'deb/PR Quest_1.0.0_amd64.deb',
    ]);
    const result = smoke('x86_64-unknown-linux-gnu');

    expect(result.status).toBe(0);
    expect(result.smoked).toBe(
      'desktop-smoke appimage/PR Quest_1.0.0_amd64.AppImage --target x86_64-unknown-linux-gnu --headless\n' +
        'desktop-smoke deb/PR Quest_1.0.0_amd64.deb --target x86_64-unknown-linux-gnu --headless\n',
    );
  });

  test('smoke-tests the Windows installer', () => {
    bundles('x86_64-pc-windows-msvc', ['nsis/PR Quest_1.0.0_x64-setup.exe']);

    expect(smoke('x86_64-pc-windows-msvc').smoked).toBe(
      'desktop-smoke nsis/PR Quest_1.0.0_x64-setup.exe --target x86_64-pc-windows-msvc\n',
    );
  });

  test('stops unless every bundle of the target is there', () => {
    bundles('aarch64-apple-darwin', ['dmg/PR Quest_1.0.0_aarch64.dmg']);
    const result = smoke('aarch64-apple-darwin');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Expected one .app in');
    expect(result.smoked).toBe('');
  });

  test('stops at two bundles of a kind', () => {
    bundles('x86_64-pc-windows-msvc', [
      'nsis/PR Quest_1.0.0_x64-setup.exe',
      'nsis/PR Quest_0.9.0_x64-setup.exe',
    ]);
    const result = smoke('x86_64-pc-windows-msvc');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Expected one -setup.exe in');
    expect(result.smoked).toBe('');
  });

  test('smoke-tests the dmg and the app in the update archive of the release files', () => {
    releaseFiles({ 'PR-Quest_1.0.0_aarch64.dmg': '', 'build-aarch64-apple-darwin.txt': '' });
    updateArchive('PR-Quest_1.0.0_aarch64.app.tar.gz');
    const result = smoke('aarch64-apple-darwin', {}, join(dir, 'files'));

    expect(result.status).toBe(0);
    expect(result.smoked).toBe(
      'desktop-smoke unpacked/PR Quest.app --target aarch64-apple-darwin\n' +
        'desktop-smoke PR-Quest_1.0.0_aarch64.dmg --target aarch64-apple-darwin\n',
    );
    expect(readdirSync(join(dir, 'tmp'))).toEqual([]);
  });

  test('smoke-tests the AppImage, made executable, and the deb of the release files', () => {
    releaseFiles({ 'PR-Quest_1.0.0_amd64.AppImage': '', 'PR-Quest_1.0.0_amd64.deb': '' });
    const result = smoke('x86_64-unknown-linux-gnu', {}, join(dir, 'files'));

    expect(result.status).toBe(0);
    expect(result.smoked).toBe(
      'desktop-smoke PR-Quest_1.0.0_amd64.AppImage --target x86_64-unknown-linux-gnu --headless\n' +
        'desktop-smoke PR-Quest_1.0.0_amd64.deb --target x86_64-unknown-linux-gnu --headless\n',
    );
    expect(statSync(join(dir, 'files', 'PR-Quest_1.0.0_amd64.AppImage')).mode & 0o100).toBe(0o100);
  });

  test('smoke-tests the installer of the release files', () => {
    releaseFiles({ 'PR-Quest_1.0.0_x64-setup.exe': '' });

    expect(smoke('x86_64-pc-windows-msvc', {}, join(dir, 'files')).smoked).toBe(
      'desktop-smoke PR-Quest_1.0.0_x64-setup.exe --target x86_64-pc-windows-msvc\n',
    );
  });

  test('stops when the release files lack the update archive', () => {
    releaseFiles({ 'PR-Quest_1.0.0_aarch64.dmg': '' });
    const result = smoke('aarch64-apple-darwin', {}, join(dir, 'files'));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Expected one .app.tar.gz in');
    expect(result.smoked).toBe('');
  });

  test('stops at the first bundle that fails', () => {
    bundles('x86_64-pc-windows-msvc', ['nsis/PR Quest_1.0.0_x64-setup.exe']);

    expect(smoke('x86_64-pc-windows-msvc', { STUB_JUST_STATUS: '1' }).status).toBe(1);
  });

  test('stops for a target it has no smoke test for', () => {
    const result = smoke('x86_64-unknown-freebsd');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('No smoke test for x86_64-unknown-freebsd');
  });
});
