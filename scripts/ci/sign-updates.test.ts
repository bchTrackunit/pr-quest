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

const script = resolve(import.meta.dirname, 'sign-updates.sh');

const v = '1.2.0';
const UPDATES = [
  `PR-Quest_${v}_aarch64.app.tar.gz`,
  `PR-Quest_${v}_x64.app.tar.gz`,
  `PR-Quest_${v}_amd64.AppImage`,
  `PR-Quest_${v}_aarch64.AppImage`,
  `PR-Quest_${v}_x64-setup.exe`,
];
const PUBKEY = Buffer.from(
  'untrusted comment: minisign public key: 06F90E2B574A444B\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n',
).toString('base64');

let dir: string;

function stub(name: string, body: string): void {
  writeFileSync(join(dir, 'tools', name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, 'tools', name), 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sign-updates-'));
  mkdirSync(join(dir, 'tools'));
  // `cargo-tauri signer sign --app-version <v> <file>`: the stand-in "signature" names the
  // version, and the file and key the signer saw go into a log.
  stub(
    'cargo-tauri',
    `echo "$5 key=$TAURI_SIGNING_PRIVATE_KEY password=[$TAURI_SIGNING_PRIVATE_KEY_PASSWORD]" >>"$STUB_DIR/signed"
printf 'version:%s' "\${STUB_SIGNED_VERSION:-$4}" | base64 >"$5.sig"`,
  );
  // `minisign -V -Q -P <key> -m <file> -x <signature>` prints the verified trusted comment.
  stub(
    'minisign',
    `[ "\${STUB_VERIFY:-ok}" = ok ] || exit 1
[ "$4" = RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3 ] || exit 1
printf 'timestamp:1\\tfile:x\\t%s\\n' "$(cat "$8")"`,
  );
  for (const [job, names] of [
    ['desktop-mac-arm64', [UPDATES[0], `PR-Quest_${v}_aarch64.dmg`]],
    ['desktop-mac-x64', [UPDATES[1]]],
    ['desktop-linux-x64', [UPDATES[2], `PR-Quest_${v}_amd64.deb`]],
    ['desktop-linux-arm64', [UPDATES[3]]],
    ['desktop-win-x64', [UPDATES[4], 'build-x86_64-pc-windows-msvc.txt']],
  ] as const) {
    mkdirSync(join(dir, 'in', job), { recursive: true });
    for (const name of names) {
      writeFileSync(join(dir, 'in', job, name ?? ''), 'bundle');
    }
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(env: Record<string, string> = {}) {
  const result = spawnSync('bash', [script, join(dir, 'in'), join(dir, 'out'), v], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      SIGN_UPDATES_TOOLS: join(dir, 'tools'),
      STUB_DIR: dir,
      TAURI_SIGNING_PRIVATE_KEY: 'private key',
      PR_QUEST_UPDATER_PUBKEY: PUBKEY,
      ...env,
    },
  });
  const signed = existsSync(join(dir, 'signed')) ? readFileSync(join(dir, 'signed'), 'utf8') : '';
  const out = existsSync(join(dir, 'out')) ? readdirSync(join(dir, 'out')).sort() : [];
  return { status: result.status, stdout: result.stdout, signed, out };
}

describe.skipIf(process.platform === 'win32')('sign-updates.sh', () => {
  test('signs a probe, then exactly the five update files, and writes only their .sig files', () => {
    const result = run();

    expect(result.status).toBe(0);
    expect(result.out).toEqual(UPDATES.map((name) => `${name}.sig`).sort());
    const signed = result.signed.trim().split('\n');
    expect(signed[0]).toMatch(/\/probe key=private key password=\[\]$/);
    expect(signed.slice(1).map((line) => line.split('/').pop()?.split(' ')[0])).toEqual(UPDATES);
    expect(readFileSync(join(dir, 'out', `${UPDATES[2]}.sig`), 'utf8').trim()).toBe(
      Buffer.from(`version:${v}`).toString('base64'),
    );
  });

  test('passes the key password on to the signer', () => {
    expect(run({ TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'pw' }).signed).toContain('password=[pw]');
  });

  test('stops before signing anything when the key does not match the public key', () => {
    const result = run({ STUB_VERIFY: 'fail' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("the key pair doesn't match, or the password is wrong");
    expect(result.signed.trim().split('\n')).toHaveLength(1);
    expect(result.out).toEqual([]);
  });

  test('stops when a signature is not bound to the version', () => {
    const result = run({ STUB_SIGNED_VERSION: '1.1.0' });

    expect(result.status).toBe(1);
    expect(result.out).toEqual([]);
  });

  test.each([
    ['the private key', { TAURI_SIGNING_PRIVATE_KEY: '' }, 'TAURI_SIGNING_PRIVATE_KEY'],
    ['the public key', { PR_QUEST_UPDATER_PUBKEY: '' }, 'PR_QUEST_UPDATER_PUBKEY'],
    [
      'a public key that is not one',
      { PR_QUEST_UPDATER_PUBKEY: Buffer.from('hello\nworld\n').toString('base64') },
      "isn't a Tauri updater public key",
    ],
  ])('stops without %s', (_case, env, message) => {
    const result = run(env);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(message);
    expect(result.signed).toBe('');
  });

  test('stops when an update file is missing or comes from two jobs', () => {
    rmSync(join(dir, 'in', 'desktop-linux-arm64', UPDATES[3] ?? ''));
    expect(run().stdout).toContain(
      `Expected one ${UPDATES[3]} among the build jobs' files, found 0`,
    );

    rmSync(join(dir, 'out'), { recursive: true });
    writeFileSync(join(dir, 'in', 'desktop-linux-arm64', UPDATES[3] ?? ''), 'bundle');
    writeFileSync(join(dir, 'in', 'desktop-win-x64', UPDATES[3] ?? ''), 'bundle');
    expect(run().stdout).toContain(`found 2`);
  });

  test('checks the signer it downloads against its pinned SHA-256', () => {
    const fake = join(dir, 'fake-bin');
    mkdirSync(fake);
    writeFileSync(
      join(fake, 'curl'),
      '#!/bin/sh\nwhile [ "$1" != --output ]; do shift; done; echo "not the signer" >"$2"\n',
    );
    writeFileSync(join(fake, 'uname'), '#!/bin/sh\n[ "$1" = -s ] && echo Linux || echo x86_64\n');
    chmodSync(join(fake, 'curl'), 0o755);
    chmodSync(join(fake, 'uname'), 0o755);
    const result = run({ SIGN_UPDATES_TOOLS: '', PATH: `${fake}:${process.env.PATH ?? ''}` });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('cargo-tauri-x86_64-unknown-linux-gnu.tgz has SHA-256');
    expect(result.stdout).toContain('not the pinned 820ae3c7');
  });
});
