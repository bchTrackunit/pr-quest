import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const script = resolve(import.meta.dirname, 'smoke.sh');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smoke-'));
  mkdirSync(join(dir, 'bin'));
  // Records each `just desktop-smoke <artifact> <flags>`, with the bundle folder taken off.
  writeFileSync(
    join(dir, 'bin', 'just'),
    `#!/bin/sh\necho "$*" | sed "s|$BUNDLES/||" >>"$STUB_DIR/smoked"\nexit "\${STUB_JUST_STATUS:-0}"\n`,
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

function smoke(triple: string, env: Record<string, string> = {}) {
  const result = spawnSync('bash', [script, triple], {
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      CARGO_TARGET_DIR: join(dir, 'target'),
      BUNDLES: join(dir, 'target', triple, 'release', 'bundle'),
      STUB_DIR: dir,
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
    expect(result.stdout).toContain('Expected 2 bundles');
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
