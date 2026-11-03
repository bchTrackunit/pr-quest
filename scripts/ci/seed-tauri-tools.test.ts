import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const script = resolve(import.meta.dirname, 'seed-tauri-tools.sh');

const RUNTIME_SHA256 = '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d';
/** The x86_64 pins, by URL: the stub sha256sum reports these for what the stub curl fetched. */
const PINS: Record<string, string> = {
  'https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64':
    'f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f',
  'https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy-07333c6/linuxdeploy-x86_64.AppImage':
    '36a2d7e274d12e1050d0e9ecfe11d339ed54720b2bec464c286d53f8b07f5c62',
  'https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/1-alpha-20250213-1/linuxdeploy-plugin-appimage-x86_64.AppImage':
    '992d502a248e14ab185448ddf6f6e7d25558cb84d4623c354c3af350c25fccb3',
  'https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64':
    RUNTIME_SHA256,
};

let dir: string;

function stub(name: string, body: string): void {
  writeFileSync(join(dir, 'bin', name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, 'bin', name), 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seed-tauri-tools-'));
  for (const sub of ['bin', 'repo/node_modules/@tauri-apps/cli', 'repo/src-tauri']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  cli('2.12.4');
  writeFileSync(join(dir, 'repo/src-tauri/tauri.conf.json'), '{"bundle": {}}');
  stub('uname', `echo "\${STUB_ARCH:-x86_64}"`);
  // Each "download" holds its URL; sha256sum looks the URL up among the pins.
  stub(
    'curl',
    'url=""; out=""; while [ $# -gt 0 ]; do case "$1" in --output) out="$2"; shift ;; https://*) url="$1" ;; esac; shift; done; echo "$url" >"$out"',
  );
  writeFileSync(
    join(dir, 'pins'),
    Object.entries(PINS)
      .map(([url, sha256]) => `${url} ${sha256}`)
      .join('\n'),
  );
  stub(
    'sha256sum',
    `hash="$(grep -F "$(cat "$1") " "$STUB_PINS" | cut -d " " -f 2)"; echo "\${hash:-0000}  $1"`,
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cli(version: string): void {
  writeFileSync(
    join(dir, 'repo/node_modules/@tauri-apps/cli/package.json'),
    JSON.stringify({ version }),
  );
}

function run(args: Array<string> = [], env: Record<string, string> = {}) {
  const result = spawnSync('bash', [script, ...args], {
    cwd: join(dir, 'repo'),
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      XDG_CACHE_HOME: join(dir, 'cache'),
      GITHUB_ENV: join(dir, 'github-env'),
      STUB_PINS: join(dir, 'pins'),
      ...env,
    },
  });
  const cache = join(dir, 'cache', 'tauri');
  return {
    status: result.status,
    stdout: result.stdout,
    cached: existsSync(cache) ? readdirSync(cache).sort() : [],
    githubEnv: existsSync(join(dir, 'github-env'))
      ? readFileSync(join(dir, 'github-env'), 'utf8')
      : '',
  };
}

describe.skipIf(process.platform === 'win32')('seed-tauri-tools.sh', () => {
  test('caches every pinned tool and exports the runtime as LDAI_RUNTIME_FILE', () => {
    const result = run();

    expect(result.status).toBe(0);
    expect(result.cached).toEqual([
      'AppRun-x86_64',
      'appimage-runtime-20251108-x86_64',
      'linuxdeploy-07333c6-x86_64.AppImage',
      'linuxdeploy-plugin-appimage.AppImage',
    ]);
    expect(result.githubEnv).toBe(
      `LDAI_RUNTIME_FILE=${join(dir, 'cache', 'tauri', 'appimage-runtime-20251108-x86_64')}\n`,
    );
  });

  test('stops at a download that does not match its pin, and keeps nothing of it', () => {
    writeFileSync(join(dir, 'pins'), '');
    const result = run();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('AppRun-x86_64 has SHA-256 0000, not the pinned f30140a4');
    expect(result.cached).toEqual([]);
    expect(result.githubEnv).toBe('');
  });

  test('stops when the installed Tauri CLI is not the one the pins are for', () => {
    cli('2.13.0');
    const result = run();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('for Tauri CLI 2.12.4, but 2.13.0 is installed');
    expect(result.cached).toEqual([]);
  });

  test('stops on a processor it has no pins for', () => {
    const result = run([], { STUB_ARCH: 'riscv64' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('No pinned AppImage tools for riscv64');
  });

  test('stops when tauri.conf.json keeps the tools somewhere else', () => {
    writeFileSync(
      join(dir, 'repo/src-tauri/tauri.conf.json'),
      '{"bundle": {"useLocalToolsDir": true}}',
    );
    const result = run();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('sets bundle.useLocalToolsDir');
    expect(result.cached).toEqual([]);
  });

  describe('--check-runtime', () => {
    test('accepts the pinned runtime', () => {
      const runtime = join(dir, 'runtime');
      writeFileSync(
        runtime,
        'https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64\n',
      );

      expect(run(['--check-runtime', runtime]).status).toBe(0);
    });

    test('refuses any other file, or none', () => {
      const other = join(dir, 'other');
      writeFileSync(other, 'a newer runtime');
      const result = run(['--check-runtime', other]);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`not the pinned x86_64 runtime's ${RUNTIME_SHA256}`);
      expect(run(['--check-runtime', join(dir, 'missing')]).stdout).toContain("isn't a file");
    });
  });
});
