import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const script = resolve(import.meta.dirname, '../../scripts/package-release.sh');

const macCertificate = { CSC_LINK: 'cert', CSC_KEY_PASSWORD: 'pw' };
const macApiKey = {
  APPLE_API_KEY_P8: '-----BEGIN PRIVATE KEY-----',
  APPLE_API_KEY_ID: 'ABC123',
  APPLE_API_ISSUER: 'issuer',
};
const macAccount = {
  APPLE_ID: 'me@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'app-pw',
  APPLE_TEAM_ID: 'TEAM123456',
};
const azure = {
  AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net',
  AZURE_SIGNING_ACCOUNT: 'account',
  AZURE_SIGNING_PROFILE: 'profile',
  AZURE_SIGNING_PUBLISHER: 'CN=Jane Doe',
  AZURE_TENANT_ID: 'tenant',
  AZURE_CLIENT_ID: 'client',
  AZURE_CLIENT_SECRET: 'secret',
};
const pfx = { WIN_CSC_LINK: 'pfx', WIN_CSC_KEY_PASSWORD: 'pw' };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'package-release-'));
  // The stub yarn records what electron-builder would get, including whether the API key file
  // exists while it runs.
  writeFileSync(
    join(dir, 'yarn'),
    `#!/bin/sh
{
  echo "CSC_IDENTITY_AUTO_DISCOVERY=\${CSC_IDENTITY_AUTO_DISCOVERY:-}"
  echo "APPLE_API_KEY=\${APPLE_API_KEY:-}"
  echo "APPLE_API_KEY_P8=\${APPLE_API_KEY_P8:-}"
  if [ -n "\${APPLE_API_KEY:-}" ] && [ -f "$APPLE_API_KEY" ]; then echo "key=$(cat "$APPLE_API_KEY")"; fi
} >"$STUB_OUT"
`,
  );
  writeFileSync(join(dir, 'uname'), '#!/bin/sh\necho "$STUB_UNAME"\n');
  chmodSync(join(dir, 'yarn'), 0o755);
  chmodSync(join(dir, 'uname'), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(os: 'Darwin' | 'MINGW64_NT-10.0' | 'Linux', env: Record<string, string> = {}) {
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    // Only what's given here, so a developer's own signing settings never leak in.
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      HOME: dir,
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: join(dir, 'output'),
      STUB_OUT: join(dir, 'yarn-env'),
      STUB_UNAME: os,
      ...env,
    },
  });
  const packaged = existsSync(join(dir, 'yarn-env'));
  return {
    status: result.status,
    stdout: result.stdout,
    packaged,
    yarnEnv: packaged ? readFileSync(join(dir, 'yarn-env'), 'utf8') : '',
    output: existsSync(join(dir, 'output')) ? readFileSync(join(dir, 'output'), 'utf8') : '',
  };
}

describe.skipIf(process.platform === 'win32')('package-release.sh', () => {
  describe('macOS', () => {
    test('builds unsigned, without the keychain, when no secret is set', () => {
      const result = run('Darwin');

      expect(result.status).toBe(0);
      expect(result.output).toBe('signed=false\n');
      expect(result.yarnEnv).toContain('CSC_IDENTITY_AUTO_DISCOVERY=false');
      expect(result.stdout).toContain('::warning title=Unsigned build::');
    });

    test('treats empty secrets as not set', () => {
      const result = run('Darwin', { CSC_LINK: '', APPLE_API_KEY_P8: '' });

      expect(result.status).toBe(0);
      expect(result.output).toBe('signed=false\n');
    });

    test('stops an unsigned build when REQUIRE_SIGNING is true', () => {
      const result = run('Darwin', { REQUIRE_SIGNING: 'true' });

      expect(result.status).toBe(1);
      expect(result.packaged).toBe(false);
      expect(result.stdout).toContain('REQUIRE_SIGNING');
    });

    test('signs and notarizes with the API key, removing the key file afterwards', () => {
      const result = run('Darwin', { ...macCertificate, ...macApiKey, REQUIRE_SIGNING: 'true' });

      expect(result.status).toBe(0);
      expect(result.output).toBe('signed=true\n');
      expect(result.yarnEnv).toContain(`key=${macApiKey.APPLE_API_KEY_P8}`);
      expect(result.yarnEnv).toContain('APPLE_API_KEY_P8=\n');
      const keyFile = /APPLE_API_KEY=(.+)/.exec(result.yarnEnv)?.[1];
      expect(keyFile).toMatch(/AuthKey_ABC123\.p8$/);
      expect(existsSync(keyFile ?? '')).toBe(false);
    });

    test('signs and notarizes with an Apple Account', () => {
      const result = run('Darwin', { ...macCertificate, ...macAccount });

      expect(result.status).toBe(0);
      expect(result.output).toBe('signed=true\n');
    });

    test.each([
      ['the certificate is missing', { ...macApiKey }, 'CSC_LINK, CSC_KEY_PASSWORD'],
      ['its password is missing', { CSC_LINK: 'cert', ...macApiKey }, 'CSC_KEY_PASSWORD'],
      ['notarization is missing', { ...macCertificate }, 'APPLE_API_KEY_P8'],
      [
        'part of the API key is missing',
        { ...macCertificate, APPLE_API_KEY_P8: 'key' },
        'APPLE_API_KEY_ID, APPLE_API_ISSUER',
      ],
      [
        'part of the Apple Account is missing',
        { ...macCertificate, APPLE_ID: 'me@example.com' },
        'APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID',
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
    });
  });

  describe('Windows', () => {
    test('builds unsigned when no secret is set', () => {
      const result = run('MINGW64_NT-10.0');

      expect(result.status).toBe(0);
      expect(result.output).toBe('signed=false\n');
    });

    test('stops an unsigned build when REQUIRE_SIGNING is true', () => {
      const result = run('MINGW64_NT-10.0', { REQUIRE_SIGNING: 'true' });

      expect(result.status).toBe(1);
      expect(result.packaged).toBe(false);
    });

    test.each([
      ['Trusted Signing', azure],
      ['a certificate file', pfx],
    ])('signs with %s', (_case, env) => {
      const result = run('MINGW64_NT-10.0', { ...env, REQUIRE_SIGNING: 'true' });

      expect(result.status).toBe(0);
      expect(result.output).toBe('signed=true\n');
    });

    test.each([
      [
        'Trusted Signing is partly set',
        { AZURE_SIGNING_ACCOUNT: 'account', AZURE_CLIENT_SECRET: 'secret' },
        'AZURE_SIGNING_ENDPOINT',
      ],
      ['the certificate file has no password', { WIN_CSC_LINK: 'pfx' }, 'WIN_CSC_KEY_PASSWORD'],
      ['only the password is set', { WIN_CSC_KEY_PASSWORD: 'pw' }, 'WIN_CSC_LINK'],
      ['both ways are set', { ...azure, ...pfx }, 'not both'],
    ])('stops when %s', (_case, env, message) => {
      const result = run('MINGW64_NT-10.0', env);

      expect(result.status).toBe(1);
      expect(result.packaged).toBe(false);
      expect(result.stdout).toContain(message);
    });
  });

  test('Linux builds are never signed, so REQUIRE_SIGNING leaves them alone', () => {
    const result = run('Linux', { REQUIRE_SIGNING: 'true' });

    expect(result.status).toBe(0);
    expect(result.output).toBe('signed=false\n');
  });
});
