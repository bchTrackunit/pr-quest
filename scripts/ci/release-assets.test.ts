import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';

const repoRoot = resolve(import.meta.dirname, '../..');
const script = join(repoRoot, 'scripts', 'ci', 'release-assets.sh');
const tauri = join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const VERSION = '1.2.0-beta.1';
const DOWNLOAD = `https://github.com/octocat/pr-quest/releases/download/v${VERSION}`;

/** What each release build job uploads, by job. */
const JOBS: Record<string, ReadonlyArray<string>> = {
  'desktop-mac-arm64': [
    `PR-Quest_${VERSION}_aarch64.dmg`,
    `PR-Quest_${VERSION}_aarch64.app.tar.gz`,
  ],
  'desktop-mac-x64': [`PR-Quest_${VERSION}_x64.dmg`, `PR-Quest_${VERSION}_x64.app.tar.gz`],
  'desktop-linux-x64': [`PR-Quest_${VERSION}_amd64.AppImage`, `PR-Quest_${VERSION}_amd64.deb`],
  'desktop-linux-arm64': [`PR-Quest_${VERSION}_aarch64.AppImage`, `PR-Quest_${VERSION}_arm64.deb`],
  'desktop-win-x64': [`PR-Quest_${VERSION}_x64-setup.exe`],
};
const UPDATE_FILES: Record<string, string> = {
  'darwin-aarch64': `PR-Quest_${VERSION}_aarch64.app.tar.gz`,
  'darwin-x86_64': `PR-Quest_${VERSION}_x64.app.tar.gz`,
  'linux-x86_64': `PR-Quest_${VERSION}_amd64.AppImage`,
  'linux-aarch64': `PR-Quest_${VERSION}_aarch64.AppImage`,
  'windows-x86_64': `PR-Quest_${VERSION}_x64-setup.exe`,
};
const ManifestSchema = z.object({
  version: z.string(),
  notes: z.string(),
  pub_date: z.string(),
  platforms: z.record(z.string(), z.object({ signature: z.string(), url: z.string() })),
});

let keys: string;
let fixture: string;
let dir: string;

function generateKey(path: string): string {
  execFileSync(process.execPath, [tauri, 'signer', 'generate', '--ci', '-p', '', '-w', path], {
    stdio: 'ignore',
  });
  return readFileSync(`${path}.pub`, 'utf8').trim();
}

function sign(file: string, key: string, version = VERSION): void {
  execFileSync(process.execPath, [tauri, 'signer', 'sign', '--app-version', version, file], {
    stdio: 'ignore',
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: readFileSync(key, 'utf8'),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
    },
  });
}

let pubkey: string;

beforeAll(() => {
  keys = mkdtempSync(join(tmpdir(), 'release-assets-keys-'));
  pubkey = generateKey(join(keys, 'updater.key'));
  generateKey(join(keys, 'other.key'));
  // The build jobs' uploads, signed once and copied for each test.
  fixture = join(keys, 'artifacts');
  for (const [job, files] of Object.entries(JOBS)) {
    mkdirSync(join(fixture, job), { recursive: true });
    for (const file of files) {
      writeFileSync(join(fixture, job, file), `${file} contents`);
      if (Object.values(UPDATE_FILES).includes(file)) {
        sign(join(fixture, job, file), join(keys, 'updater.key'));
      }
    }
  }
  // The stub just runs the repository's own check, as `just desktop-verify-updater` does.
  writeFileSync(
    join(keys, 'just'),
    `#!/bin/sh\n[ "$1" = desktop-verify-updater ] || exit 64\nexec "${process.execPath}" "${join(repoRoot, 'scripts', 'verify-updater-signature.ts')}" "$2"\n`,
  );
  chmodSync(join(keys, 'just'), 0o755);
}, 60_000);

afterAll(() => {
  rmSync(keys, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-assets-'));
  cpSync(fixture, join(dir, 'artifacts'), { recursive: true });
  return () => rmSync(dir, { recursive: true, force: true });
});

function run(
  env: Record<string, string> = { PR_QUEST_UPDATER_PUBKEY: pubkey },
  download = DOWNLOAD,
) {
  const result = spawnSync(
    'bash',
    [script, join(dir, 'artifacts'), join(dir, 'assets'), VERSION, download],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${keys}:${process.env.PATH ?? ''}`, HOME: dir, ...env },
    },
  );
  return { status: result.status, stdout: result.stdout };
}

function artifact(job: string, file: string): string {
  return join(dir, 'artifacts', job, file);
}

describe.skipIf(process.platform === 'win32')('release-assets.sh', () => {
  test('writes latest.json with every platform, its download URL and its signature', () => {
    const result = run();

    expect(result.status).toBe(0);
    const manifest = ManifestSchema.parse(
      JSON.parse(readFileSync(join(dir, 'assets', 'latest.json'), 'utf8')),
    );
    expect(manifest.version).toBe(VERSION);
    expect(manifest.notes).toBe(`PR Quest ${VERSION}`);
    expect(manifest.pub_date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(Object.keys(manifest.platforms).sort()).toEqual(Object.keys(UPDATE_FILES).sort());
    for (const [platform, file] of Object.entries(UPDATE_FILES)) {
      const job = Object.keys(JOBS).find((name) => JOBS[name]?.includes(file)) ?? '';
      expect(manifest.platforms[platform]).toEqual({
        url: `${DOWNLOAD}/${file}`,
        signature: readFileSync(artifact(job, `${file}.sig`), 'utf8').trim(),
      });
    }
  });

  test('releases exactly the installers, the update files, latest.json and the checksums', () => {
    expect(run().status).toBe(0);

    const assets = readdirSync(join(dir, 'assets')).sort();
    const expected = [
      ...Object.values(JOBS).flat(),
      ...Object.values(UPDATE_FILES).map((file) => `${file}.sig`),
      'latest.json',
      'SHA256SUMS.txt',
    ].sort();
    expect(assets).toEqual(expected);
    const sums = readFileSync(join(dir, 'assets', 'SHA256SUMS.txt'), 'utf8');
    for (const name of expected.filter((file) => file !== 'SHA256SUMS.txt')) {
      const sha256 = createHash('sha256')
        .update(readFileSync(join(dir, 'assets', name)))
        .digest('hex');
      expect(sums).toContain(`${sha256}  ${name}\n`);
    }
  });

  test('stops when a platform is missing', () => {
    rmSync(join(dir, 'artifacts', 'desktop-linux-arm64'), { recursive: true });

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`No build job produced PR-Quest_${VERSION}_arm64.deb`);
  });

  test('stops at a file it does not expect', () => {
    writeFileSync(artifact('desktop-win-x64', 'PR-Quest_0.0.0_x64-setup.exe'), 'old');

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("PR-Quest_0.0.0_x64-setup.exe isn't a release asset");
  });

  test('stops when two jobs produced the same file', () => {
    cpSync(
      artifact('desktop-mac-x64', `PR-Quest_${VERSION}_x64.dmg`),
      artifact('desktop-mac-arm64', `PR-Quest_${VERSION}_x64.dmg`),
    );

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`More than one build job produced PR-Quest_${VERSION}_x64.dmg`);
  });

  test('stops when an update file was changed after it was signed', () => {
    appendFileSync(artifact('desktop-win-x64', `PR-Quest_${VERSION}_x64-setup.exe`), 'tampered');

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      `PR-Quest_${VERSION}_x64-setup.exe.sig isn't a valid signature`,
    );
  });

  test('stops when an update file was signed with another key', () => {
    sign(
      artifact('desktop-mac-arm64', `PR-Quest_${VERSION}_aarch64.app.tar.gz`),
      join(keys, 'other.key'),
    );

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      `PR-Quest_${VERSION}_aarch64.app.tar.gz.sig isn't a valid signature`,
    );
  });

  test('stops when a signature is bound to another version', () => {
    sign(
      artifact('desktop-linux-x64', `PR-Quest_${VERSION}_amd64.AppImage`),
      join(keys, 'updater.key'),
      '1.1.0',
    );

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`is bound to version "1.1.0", not ${VERSION}`);
  });

  test('stops without the updater public key, rather than using the local one', () => {
    const result = run({});

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("PR_QUEST_UPDATER_PUBKEY isn't set");
  });

  test('stops for a download URL that is not a GitHub release', () => {
    const result = run(undefined, 'https://example.com/releases/download/v1.2.0');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("isn't a GitHub release download URL");
  });

  test('never reuses an output folder that has files in it', () => {
    mkdirSync(join(dir, 'assets'));
    renameSync(
      artifact('desktop-win-x64', `PR-Quest_${VERSION}_x64-setup.exe`),
      join(dir, 'assets', 'stale'),
    );

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("isn't empty");
  });
});
