import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const script = resolve(import.meta.dirname, 'package.sh');

const IDENTITY = 'Developer ID Application: Jane Doe (TEAM123456)';
const THUMBPRINT = '0123456789ABCDEF0123456789ABCDEF01234567';
const release = {
  PR_QUEST_RELEASE_BUILD: '1',
  PR_QUEST_UPDATER_PUBKEY: 'pubkey',
  TAURI_SIGNING_PRIVATE_KEY: 'private key',
};
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
    PR_QUEST_UPDATER_PUBKEY; do
    eval "set=\\\${$name+set}"
    eval "value=\\\${$name:-}"
    echo "$name=\${set:+[$value]}"
  done
  if [ -n "\${APPLE_API_KEY_PATH:-}" ] && [ -f "$APPLE_API_KEY_PATH" ]; then echo "p8=$(cat "$APPLE_API_KEY_PATH")"; fi
} >"$STUB_DIR/just-env"`,
  );
  stub('uname', 'echo "$STUB_UNAME"');
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
  stub('sha256sum', 'echo "0000  $1"');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(os: 'Darwin' | 'MINGW64_NT-10.0' | 'Linux', env: Record<string, string> = {}) {
  const result = spawnSync('bash', [script, '--target', 'aarch64-apple-darwin'], {
    encoding: 'utf8',
    // Only what's given here, so a developer's own signing settings never leak in.
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      HOME: dir,
      RUNNER_TEMP: dir,
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
  };
}

describe.skipIf(process.platform === 'win32')('package.sh', () => {
  test('passes its arguments to desktop-package', () => {
    const result = run('Linux');

    expect(result.status).toBe(0);
    expect(result.env).toContain('args=desktop-package --target aarch64-apple-darwin');
  });

  describe('the updater key', () => {
    test('a release build gets it, with an empty password when the key has none', () => {
      const result = run('Linux', release);

      expect(result.status).toBe(0);
      expect(result.env).toContain('TAURI_SIGNING_PRIVATE_KEY=[private key]');
      expect(result.env).toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD=[]');
      expect(result.env).toContain('PR_QUEST_UPDATER_PUBKEY=[pubkey]');
    });

    test.each([
      [
        'the private key',
        { PR_QUEST_RELEASE_BUILD: '1', PR_QUEST_UPDATER_PUBKEY: 'pubkey' },
        'TAURI_SIGNING_PRIVATE_KEY',
      ],
      [
        'the public key',
        { PR_QUEST_RELEASE_BUILD: '1', TAURI_SIGNING_PRIVATE_KEY: 'key' },
        'PR_QUEST_UPDATER_PUBKEY',
      ],
      [
        'both, when they are empty',
        { ...release, TAURI_SIGNING_PRIVATE_KEY: '', PR_QUEST_UPDATER_PUBKEY: '' },
        'PR_QUEST_UPDATER_PUBKEY',
      ],
    ])('a release build stops without %s', (_case, env, message) => {
      const result = run('Linux', env);

      expect(result.status).toBe(1);
      expect(result.packaged).toBe(false);
      expect(result.stdout).toContain(message);
    });

    test('a dry run reads its throwaway key pair from files', () => {
      writeFileSync(join(dir, 'dry.key'), 'dry private');
      writeFileSync(join(dir, 'dry.key.pub'), 'dry public');
      const result = run('Linux', {
        PR_QUEST_RELEASE_BUILD: '1',
        UPDATER_PRIVATE_KEY_FILE: join(dir, 'dry.key'),
        UPDATER_PUBKEY_FILE: join(dir, 'dry.key.pub'),
      });

      expect(result.status).toBe(0);
      expect(result.env).toContain('TAURI_SIGNING_PRIVATE_KEY=[dry private]');
      expect(result.env).toContain('PR_QUEST_UPDATER_PUBKEY=[dry public]');
    });

    test('refuses the key files and the secrets together', () => {
      writeFileSync(join(dir, 'dry.key'), 'dry private');
      const result = run('Linux', {
        ...release,
        UPDATER_PRIVATE_KEY_FILE: join(dir, 'dry.key'),
        UPDATER_PUBKEY_FILE: join(dir, 'dry.key'),
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('not both');
    });

    test('refuses a key for a build that would ignore it', () => {
      const result = run('Linux', { TAURI_SIGNING_PRIVATE_KEY: 'key' });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("PR_QUEST_RELEASE_BUILD isn't 1");
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

    test.each(['true', 'TRUE', '1', 'yes', 'Yes'])(
      'stops an unsigned build when REQUIRE_SIGNING is %s',
      (value) => {
        const result = run('Darwin', { REQUIRE_SIGNING: value });

        expect(result.status).toBe(1);
        expect(result.packaged).toBe(false);
        expect(result.stdout).toContain('so the build stops instead of shipping it unsigned');
      },
    );

    test.each(['false', 'on', 'ture'])(
      'stops when REQUIRE_SIGNING is %s, rather than guessing what it means',
      (value) => {
        const result = run('Darwin', { ...macCertificate, ...macApiKey, REQUIRE_SIGNING: value });

        expect(result.status).toBe(1);
        expect(result.packaged).toBe(false);
        expect(result.stdout).toContain(`REQUIRE_SIGNING is "${value}"`);
      },
    );

    test('signs from a temporary keychain and notarizes with the API key, then cleans up', () => {
      const result = run('Darwin', { ...macCertificate, ...macApiKey, REQUIRE_SIGNING: 'true' });

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
        `security import ${keychain.replace('signing.keychain-db', 'certificate.p12')} -k ${keychain}`,
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
    ])('stops when %s, whatever REQUIRE_SIGNING says', (_case, env, message) => {
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

    test('stops an unsigned build when REQUIRE_SIGNING is true', () => {
      const result = run('MINGW64_NT-10.0', { REQUIRE_SIGNING: 'true' });

      expect(result.status).toBe(1);
      expect(result.packaged).toBe(false);
    });

    test('signs with a certificate file through signtool, then removes it from the store', () => {
      const result = run('MINGW64_NT-10.0', { ...pfx, REQUIRE_SIGNING: 'true' });

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
    test('is never code signed, so REQUIRE_SIGNING leaves it alone', () => {
      const result = run('Linux', { REQUIRE_SIGNING: 'true' });

      expect(result.status).toBe(0);
      expect(result.output).toBe('signed=false\n');
    });

    test("refuses other platforms' signing secrets", () => {
      const result = run('Linux', macCertificate);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Linux builds aren't code signed");
    });
  });
});
