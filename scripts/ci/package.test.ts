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

const script = resolve(import.meta.dirname, 'package.sh');

const IDENTITY = 'Developer ID Application: Jane Doe (TEAM123456)';
const THUMBPRINT = '0123456789ABCDEF0123456789ABCDEF01234567';
const release = { PR_QUEST_RELEASE_BUILD: '1', PR_QUEST_UPDATER_PUBKEY: 'pubkey' };
const RUNTIME_SHA256 = '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d';
const macCertificate = {
  APPLE_CERTIFICATE: Buffer.from('p12').toString('base64'),
  APPLE_CERTIFICATE_PASSWORD: 'pw',
};
const macApiKey = {
  APPLE_API_ISSUER: 'issuer',
  APPLE_API_KEY_ID: 'ABC123',
  APPLE_API_KEY_P8: '-----BEGIN PRIVATE KEY-----',
};
const macAccount = {
  APPLE_ID: 'me@example.com',
  APPLE_PASSWORD: 'app-pw',
  APPLE_TEAM_ID: 'TEAM123456',
};
const azure = {
  AZURE_TENANT_ID: 'tenant',
  AZURE_CLIENT_ID: 'client',
  AZURE_CLIENT_SECRET: 'secret',
  AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net',
  AZURE_SIGNING_ACCOUNT: 'account',
  AZURE_SIGNING_PROFILE: 'profile',
};
const pfx = { WINDOWS_PFX: Buffer.from('pfx').toString('base64'), WINDOWS_PFX_PASSWORD: 'pw' };

let dir: string;

function stub(name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'package-'));
  // The stub just records what desktop-package would get, including whether the files it names
  // exist while it runs.
  stub(
    'just',
    `{
  echo "args=$*"
  for name in APPLE_SIGNING_IDENTITY APPLE_API_KEY APPLE_API_KEY_PATH APPLE_API_KEY_P8 APPLE_CERTIFICATE \\
    PR_QUEST_WINDOWS_SIGN_COMMAND WINDOWS_PFX TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD \\
    PR_QUEST_UPDATER_PUBKEY PR_QUEST_ALLOW_UNSIGNED_RELEASE; do
    eval "set=\\\${$name+set}"
    eval "value=\\\${$name:-}"
    echo "$name=\${set:+[$value]}"
  done
  if [ -n "\${APPLE_API_KEY_PATH:-}" ] && [ -f "$APPLE_API_KEY_PATH" ]; then echo "p8=$(cat "$APPLE_API_KEY_PATH")"; fi
  if [ -e "$STUB_DIR/target/aarch64-apple-darwin/release/bundle/pr-quest-build.txt" ]; then echo "stale record"; fi
} >"$STUB_DIR/just-env"
exit "\${STUB_JUST_STATUS:-0}"`,
  );
  stub('uname', '[ "$1" = -m ] && echo x86_64 || echo "$STUB_UNAME"');
  stub(
    'security',
    `echo "security $*" >>"$STUB_DIR/calls"
case "$1" in
  list-keychains) [ "$2 $3" = "-d user" ] && [ -z "$4" ] && echo '    "/Users/runner/Library/Keychains/login.keychain-db"' ;;
  find-identity) printf '%s\\n' "\${STUB_IDENTITIES:-  1) ABC \\"${IDENTITY}\\"}" "     1 valid identities found" ;;
esac
exit 0`,
  );
  stub('cygpath', 'echo "W:$2"');
  stub('find', 'echo "/c/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64/signtool.exe"');
  stub(
    'pwsh',
    `printf '%s\\n' "pwsh $*" >>"$STUB_DIR/calls"
case "$*" in *Import-PfxCertificate*) echo "${THUMBPRINT}" ;; esac`,
  );
  stub('dotnet', 'echo "Microsoft.NETCore.App 8.0.21 [C:\\dotnet]"');
  stub('curl', 'while [ "$1" != --output ]; do shift; done; echo "not the dlib" >"$2"');
  // The pinned AppImage runtime's SHA-256 for a file named runtime, and a wrong one otherwise.
  stub(
    'sha256sum',
    `case "$1" in */runtime) echo "${RUNTIME_SHA256}  $1" ;; *) echo "0000  $1" ;; esac`,
  );
  writeFileSync(join(dir, 'runtime'), 'runtime');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RECORD = join('target', 'aarch64-apple-darwin', 'release', 'bundle', 'pr-quest-build.txt');

function run(
  os: 'Darwin' | 'MINGW64_NT-10.0' | 'Linux',
  env: Record<string, string> = {},
  args: Array<string> = ['--target', 'aarch64-apple-darwin'],
) {
  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    // Only what's given here, so a developer's own signing settings never leak in.
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      HOME: dir,
      RUNNER_TEMP: dir,
      CARGO_TARGET_DIR: join(dir, 'target'),
      GITHUB_OUTPUT: join(dir, 'output'),
      STUB_DIR: dir,
      STUB_UNAME: os,
      ...env,
    },
  });
  const read = (name: string) =>
    existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '';
  return {
    status: result.status,
    stdout: result.stdout,
    packaged: existsSync(join(dir, 'just-env')),
    env: read('just-env'),
    output: read('output'),
    calls: read('calls'),
    record: read(RECORD),
  };
}

const dryRun = { ...release, PR_QUEST_ALLOW_UNSIGNED_RELEASE: '1' };
const linuxRelease = () => ({ ...release, LDAI_RUNTIME_FILE: join(dir, 'runtime') });

describe.skipIf(process.platform === 'win32')('package.sh', () => {
  test('passes its arguments to desktop-package', () => {
    const result = run('Linux');

    expect(result.status).toBe(0);
    expect(result.env).toContain('args=desktop-package --target aarch64-apple-darwin');
  });

  test('needs --target, to know where the bundles go', () => {
    const result = run('Linux', {}, ['--bundles', 'deb']);

    expect(result.status).toBe(1);
    expect(result.packaged).toBe(false);
    expect(result.stdout).toContain('--target <triple>');
  });

  describe('the build record', () => {
    test('says how the bundles were signed, once they are built', () => {
      const result = run('Darwin', { ...release, ...macCertificate, ...macApiKey });

      expect(result.status).toBe(0);
      expect(result.record).toBe(
        'target=aarch64-apple-darwin\nsigned=true\nunsigned_release=false\n',
      );
    });

    test("is deleted before the build, so a failed one doesn't leave an old record", () => {
      mkdirSync(dirname(join(dir, RECORD)), { recursive: true });
      writeFileSync(join(dir, RECORD), 'signed=true\n');
      const result = run('Linux', { STUB_JUST_STATUS: '1' });

      expect(result.status).toBe(1);
      expect(result.env).not.toContain('stale record');
      expect(result.record).toBe('');
    });
  });

  describe('the dry run opt-out, PR_QUEST_ALLOW_UNSIGNED_RELEASE', () => {
    test('lets a macOS or Windows release build be unsigned, and says so in the record', () => {
      for (const os of ['Darwin', 'MINGW64_NT-10.0'] as const) {
        const result = run(os, dryRun);

        expect(result.status).toBe(0);
        expect(result.env).toContain('PR_QUEST_ALLOW_UNSIGNED_RELEASE=[1]');
        expect(result.stdout).toContain('::warning title=Unsigned build::');
        expect(result.record).toContain('signed=false\nunsigned_release=true\n');
      }
    });

    test('is refused in a tag build', () => {
      const result = run('Darwin', { ...dryRun, GITHUB_EVENT_NAME: 'push' });

      expect(result.status).toBe(1);
      expect(result.packaged).toBe(false);
      expect(result.stdout).toContain('tag build, which must be signed');
    });

    test('is refused along with signing secrets', () => {
      const result = run('MINGW64_NT-10.0', { ...dryRun, ...pfx });

      expect(result.status).toBe(1);
      expect(result.packaged).toBe(false);
      expect(result.stdout).toContain('but signing secrets are set');
    });

    test.each(['true', 'yes', '0'])('is refused when it is %s rather than 1', (value) => {
      const result = run('Darwin', { ...release, PR_QUEST_ALLOW_UNSIGNED_RELEASE: value });

      expect(result.status).toBe(1);
      expect(result.packaged).toBe(false);
      expect(result.stdout).toContain(`PR_QUEST_ALLOW_UNSIGNED_RELEASE is "${value}"`);
    });

    test('is passed on unset when empty', () => {
      const result = run('Linux', { PR_QUEST_ALLOW_UNSIGNED_RELEASE: '' });

      expect(result.status).toBe(0);
      expect(result.env).toContain('PR_QUEST_ALLOW_UNSIGNED_RELEASE=\n');
    });
  });

  describe('the updater key', () => {
    test('a release build gets the public key, and nothing of the private one', () => {
      const result = run('Darwin', { ...dryRun });

      expect(result.status).toBe(0);
      expect(result.env).toContain('PR_QUEST_UPDATER_PUBKEY=[pubkey]');
      expect(result.env).toContain('TAURI_SIGNING_PRIVATE_KEY=\n');
      expect(result.env).toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD=\n');
    });

    test.each([
      'TAURI_SIGNING_PRIVATE_KEY',
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
      'TAURI_SIGNING_PRIVATE_KEY_PATH',
    ])('refuses %s, which only the sign-updates job may have', (name) => {
      for (const args of [
        ['--target', 'aarch64-apple-darwin'],
        ['--target', 'aarch64-apple-darwin', '--compile-only'],
      ]) {
        const result = run('Darwin', { ...dryRun, [name]: 'key' }, args);

        expect(result.status).toBe(1);
        expect(result.packaged).toBe(false);
        expect(result.stdout).toContain("The updater's private key reached the packaging");
      }
    });

    test('a release build stops without the public key', () => {
      const pubkeys: Array<Record<string, string>> = [{}, { PR_QUEST_UPDATER_PUBKEY: '' }];
      for (const pubkey of pubkeys) {
        const result = run('Darwin', { PR_QUEST_RELEASE_BUILD: '1', ...pubkey });

        expect(result.status).toBe(1);
        expect(result.packaged).toBe(false);
        expect(result.stdout).toContain('needs PR_QUEST_UPDATER_PUBKEY');
      }
    });
  });

  describe('--compile-only', () => {
    const compile = ['--target', 'aarch64-apple-darwin', '--compile-only'];

    test('compiles a release build without any signing secret, and writes no record', () => {
      const result = run('Darwin', release, compile);

      expect(result.status).toBe(0);
      expect(result.env).toContain(
        'args=desktop-package --target aarch64-apple-darwin --compile-only',
      );
      expect(result.env).toContain('APPLE_SIGNING_IDENTITY=\n');
      expect(result.output).toBe('');
      expect(result.record).toBe('');
      expect(result.calls).toBe('');
    });

    test.each([
      ['macOS', 'Darwin', { ...macCertificate, ...macApiKey }],
      ['Windows', 'MINGW64_NT-10.0', azure],
    ] as const)('refuses the %s signing secrets', (_platform, os, secrets) => {
      const result = run(os, { ...release, ...secrets }, compile);

      expect(result.status).toBe(1);
      expect(result.packaged).toBe(false);
      expect(result.stdout).toContain('Signing secrets reached the compile step');
      expect(result.calls).toBe('');
    });
  });

  describe('macOS', () => {
    test('builds unsigned, never with an identity from the environment, when no secret is set', () => {
      const result = run('Darwin', { APPLE_SIGNING_IDENTITY: 'Developer ID Application: Someone' });

      expect(result.status).toBe(0);
      expect(result.output).toBe('signed=false\n');
      expect(result.env).toContain('APPLE_SIGNING_IDENTITY=\n');
      expect(result.stdout).toContain('::warning title=Unsigned build::');
    });

    test('stops a release build without the signing secrets', () => {
      const result = run('Darwin', release);

      expect(result.status).toBe(1);
      expect(result.packaged).toBe(false);
      expect(result.stdout).toContain('A release build must be signed on macOS and Windows');
    });

    test('signs from a temporary keychain and notarizes with the API key, then cleans up', () => {
      const result = run('Darwin', { ...macCertificate, ...macApiKey });

      expect(result.status).toBe(0);
      expect(result.output).toBe('signed=true\n');
      expect(result.env).toContain(`APPLE_SIGNING_IDENTITY=[${IDENTITY}]`);
      expect(result.env).toContain('APPLE_API_KEY=[ABC123]');
      expect(result.env).toContain(`p8=${macApiKey.APPLE_API_KEY_P8}`);
      // Tauri gets neither the certificate nor the key's contents.
      expect(result.env).toContain('APPLE_CERTIFICATE=\n');
      expect(result.env).toContain('APPLE_API_KEY_P8=\n');
      const keyFile = /APPLE_API_KEY_PATH=\[(.+)\]/.exec(result.env)?.[1];
      expect(keyFile).toMatch(/AuthKey_ABC123\.p8$/);
      expect(existsSync(keyFile ?? '')).toBe(false);

      const keychain = /security create-keychain -p \S+ (\S+)/.exec(result.calls)?.[1] ?? '';
      expect(keychain).toMatch(/signing\.keychain-db$/);
      expect(result.calls).toContain(
        `security import ${keychain.replace('signing.keychain-db', 'certificate.p12')} -k ${keychain} -f pkcs12 -x `,
      );
      expect(result.calls).toContain(
        `security list-keychains -d user -s ${keychain} /Users/runner/Library/Keychains/login.keychain-db`,
      );
      // Afterwards: the search list as it was, and no keychain.
      expect(result.calls).toContain(
        'security list-keychains -d user -s /Users/runner/Library/Keychains/login.keychain-db\n',
      );
      expect(result.calls).toContain(`security delete-keychain ${keychain}`);
    });

    test('notarizes with an Apple Account', () => {
      const result = run('Darwin', { ...macCertificate, ...macAccount });

      expect(result.status).toBe(0);
      expect(result.output).toBe('signed=true\n');
      expect(result.env).toContain('APPLE_API_KEY_PATH=\n');
    });

    test('stops unless the certificate holds exactly one Developer ID Application identity', () => {
      const result = run('Darwin', {
        ...macCertificate,
        ...macAccount,
        STUB_IDENTITIES: '  1) ABC "Apple Development: Jane Doe (TEAM123456)"',
      });

      expect(result.status).toBe(1);
      expect(result.packaged).toBe(false);
      expect(result.stdout).toContain(
        'exactly one Developer ID Application identity, but it has 0',
      );
      expect(result.calls).toContain('security delete-keychain');
    });

    test.each([
      [
        'the certificate is missing',
        { ...macApiKey },
        'APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD',
      ],
      [
        'its password is missing',
        { APPLE_CERTIFICATE: 'cert', ...macApiKey },
        'APPLE_CERTIFICATE_PASSWORD',
      ],
      ['notarization is missing', { ...macCertificate }, 'APPLE_API_ISSUER'],
      [
        'part of the API key is missing',
        { ...macCertificate, APPLE_API_KEY_P8: 'key' },
        'APPLE_API_ISSUER, APPLE_API_KEY_ID',
      ],
      [
        'part of the Apple Account is missing',
        { ...macCertificate, APPLE_ID: 'me@example.com' },
        'APPLE_PASSWORD, APPLE_TEAM_ID',
      ],
      [
        'both ways to notarize are set',
        { ...macCertificate, ...macApiKey, ...macAccount },
        'not both',
      ],
      [
        'both are partly set',
        { ...macCertificate, APPLE_API_KEY_P8: 'key', APPLE_ID: 'me@example.com' },
        'not both',
      ],
    ])('stops when %s', (_case, env, message) => {
      const result = run('Darwin', env);

      expect(result.status).toBe(1);
      expect(result.packaged).toBe(false);
      expect(result.stdout).toContain(message);
      expect(result.calls).not.toContain('create-keychain');
    });
  });

  describe('Windows', () => {
    test('builds unsigned, never with a sign command from the environment, when no secret is set', () => {
      const result = run('MINGW64_NT-10.0', { PR_QUEST_WINDOWS_SIGN_COMMAND: 'evil %1' });

      expect(result.status).toBe(0);
      expect(result.output).toBe('signed=false\n');
      expect(result.env).toContain('PR_QUEST_WINDOWS_SIGN_COMMAND=\n');
    });

    test('stops a release build without the signing secrets', () => {
      const result = run('MINGW64_NT-10.0', release);

      expect(result.status).toBe(1);
      expect(result.packaged).toBe(false);
      expect(result.stdout).toContain('A release build must be signed on macOS and Windows');
    });

    test('signs with a certificate file through signtool, then removes it from the store', () => {
      const result = run('MINGW64_NT-10.0', { ...pfx });

      expect(result.status).toBe(0);
      expect(result.output).toBe('signed=true\n');
      expect(result.env).toContain(
        `PR_QUEST_WINDOWS_SIGN_COMMAND=["W:/c/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64/signtool.exe" sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /d "PR Quest" /sha1 ${THUMBPRINT} %1]`,
      );
      expect(result.env).toContain('WINDOWS_PFX=\n');
      expect(result.calls).toContain(`Cert:\\CurrentUser\\My\\${THUMBPRINT}' -DeleteKey`);
    });

    test('checks the Artifact Signing dlib against its pinned SHA-256 before using it', () => {
      const result = run('MINGW64_NT-10.0', azure);

      expect(result.status).toBe(1);
      expect(result.packaged).toBe(false);
      expect(result.stdout).toContain('not the pinned');
    });

    test('refuses an Artifact Signing endpoint that is not one', () => {
      const result = run('MINGW64_NT-10.0', {
        ...azure,
        AZURE_SIGNING_ENDPOINT: 'https://attacker.example/codesigning.azure.net',
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('not an endpoint');
    });

    test.each([
      [
        'Artifact Signing is partly set',
        { AZURE_SIGNING_ACCOUNT: 'account', AZURE_CLIENT_SECRET: 'secret' },
        'AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_PROFILE',
      ],
      ['the certificate file has no password', { WINDOWS_PFX: 'pfx' }, 'WINDOWS_PFX_PASSWORD'],
      ['only the password is set', { WINDOWS_PFX_PASSWORD: 'pw' }, 'WINDOWS_PFX'],
      ['both ways are set', { ...azure, ...pfx }, 'not both'],
    ])('stops when %s', (_case, env, message) => {
      const result = run('MINGW64_NT-10.0', env);

      expect(result.status).toBe(1);
      expect(result.packaged).toBe(false);
      expect(result.stdout).toContain(message);
    });
  });

  describe('Linux', () => {
    test('is never code signed, so a release build needs no signing secrets', () => {
      const result = run('Linux', linuxRelease());

      expect(result.status).toBe(0);
      expect(result.output).toBe('signed=false\n');
      expect(result.record).toContain('signed=false\nunsigned_release=false\n');
    });

    test('a release build needs the pinned AppImage runtime in LDAI_RUNTIME_FILE', () => {
      writeFileSync(join(dir, 'other-runtime'), 'runtime');
      for (const [runtime, message] of [
        ['', 'needs LDAI_RUNTIME_FILE'],
        [join(dir, 'missing'), 'needs LDAI_RUNTIME_FILE'],
        [join(dir, 'other-runtime'), "isn't the pinned AppImage runtime"],
      ] as const) {
        const result = run('Linux', { ...release, LDAI_RUNTIME_FILE: runtime });

        expect(result.status).toBe(1);
        expect(result.packaged).toBe(false);
        expect(result.stdout).toContain(message);
      }
    });

    test('a local build bundles without the runtime pin', () => {
      expect(run('Linux').status).toBe(0);
    });

    test("refuses other platforms' signing secrets", () => {
      const result = run('Linux', macCertificate);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Linux builds aren't code signed");
    });
  });
});
