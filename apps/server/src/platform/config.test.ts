import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MasterKeyring, newDataKey } from './envelope.ts';
import { HOSTED_CONFIG, LOCAL_CONFIG } from './test-utils/config.ts';
import { DEFAULT_SERVER_PORT } from '@pr-quest/contract/ports';

import {
  type AppConfig,
  assertSafeConfig,
  DEFAULT_GITHUB_CLIENT_ID,
  ENV_FILE_NAME,
  HOSTED_DEFAULT_HOST,
  loadConfig,
  LOOPBACK_HOST,
  LOOPBACK_HOSTNAMES,
} from './config.ts';

describe('loadConfig', () => {
  let dir: string;
  let envFilePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pr-quest-config-'));
    envFilePath = join(dir, '.env.local');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('reads keys from the env file when the environment lacks them', () => {
    writeFileSync(envFilePath, 'LINEAR_API_KEY=lin_file\nCURSOR_API_KEY=cur_file\n');

    const config = loadConfig({ env: {}, envFilePath });

    expect(config.linearApiKey).toBe('lin_file');
    expect(config.cursorApiKey).toBe('cur_file');
  });

  test('prefers the process environment over the env file', () => {
    writeFileSync(envFilePath, 'LINEAR_API_KEY=lin_file\n');

    const config = loadConfig({ env: { LINEAR_API_KEY: 'lin_env' }, envFilePath });

    expect(config.linearApiKey).toBe('lin_env');
  });

  test('treats blank values as missing and works without an env file', () => {
    const config = loadConfig({ env: { CURSOR_API_KEY: '  ' }, envFilePath });

    expect(config.cursorApiKey).toBeUndefined();
    expect(config.linearApiKey).toBeUndefined();
  });

  test('reads the Anthropic key and the GitHub OAuth client ID', () => {
    writeFileSync(envFilePath, 'ANTHROPIC_API_KEY=sk-ant-file\n');

    const config = loadConfig({
      env: { PR_QUEST_GITHUB_CLIENT_ID: 'Iv1.abc123' },
      envFilePath,
    });

    expect(config.anthropicApiKey).toBe('sk-ant-file');
    expect(config.githubClientId).toBe('Iv1.abc123');
  });

  test('falls back to the built-in GitHub client ID, which is empty by default', () => {
    const config = loadConfig({ env: {}, envFilePath });

    expect(config.githubClientId ?? '').toBe(DEFAULT_GITHUB_CLIENT_ID);
  });

  test('an empty environment value blanks the env file value', () => {
    writeFileSync(envFilePath, 'CURSOR_API_KEY=cur_file\n');

    expect(loadConfig({ env: { CURSOR_API_KEY: '' }, envFilePath }).cursorApiKey).toBeUndefined();
  });

  test('rejects an invalid port', () => {
    expect(() => loadConfig({ env: { PR_QUEST_PORT: 'abc' }, envFilePath })).toThrow(
      /PR_QUEST_PORT/,
    );
  });

  describe('the env file in the state directory', () => {
    test('is read from <stateDir>/.env by default', () => {
      writeFileSync(join(dir, ENV_FILE_NAME), 'CURSOR_API_KEY=cur_state\n');

      const config = loadConfig({ env: { PR_QUEST_STATE_DIR: dir } });

      expect(config.stateDir).toBe(dir);
      expect(config.cursorApiKey).toBe('cur_state');
    });

    test('defaults the state directory to ~/.pr-quest', () => {
      expect(loadConfig({ env: {}, envFilePath }).stateDir).toBe(join(homedir(), '.pr-quest'));
    });

    test('refuses to move the state directory from inside it', () => {
      writeFileSync(envFilePath, `PR_QUEST_STATE_DIR=${join(dir, 'elsewhere')}\n`);

      expect(() => loadConfig({ env: {}, envFilePath })).toThrow(/PR_QUEST_STATE_DIR/);
    });

    test.skipIf(process.platform === 'win32')(
      'warns when other users may read it, as it can hold API keys',
      () => {
        const warnings: Array<string> = [];
        writeFileSync(envFilePath, 'CURSOR_API_KEY=cur_state\n', { mode: 0o644 });
        chmodSync(envFilePath, 0o644);

        loadConfig({ env: {}, envFilePath, onWarning: (message) => warnings.push(message) });
        chmodSync(envFilePath, 0o600);
        loadConfig({ env: {}, envFilePath, onWarning: (message) => warnings.push(message) });

        expect(warnings).toEqual([expect.stringContaining('chmod 600')]);
      },
    );
  });

  describe('the legacy env file', () => {
    let legacyEnvFilePath: string;

    beforeEach(() => {
      legacyEnvFilePath = join(dir, 'repo', '.env.local');
      mkdirSync(join(dir, 'repo'));
    });

    test('fills in what neither the environment nor the state env file sets', () => {
      writeFileSync(legacyEnvFilePath, 'CURSOR_API_KEY=cur_legacy\nLINEAR_API_KEY=lin_legacy\n');
      writeFileSync(envFilePath, 'LINEAR_API_KEY=lin_state\n');

      const config = loadConfig({ env: {}, envFilePath, legacyEnvFilePath });

      expect(config.cursorApiKey).toBe('cur_legacy');
      expect(config.linearApiKey).toBe('lin_state');
    });

    test('can still choose the state directory, whose env file it then reads', () => {
      const stateDir = join(dir, 'state');
      mkdirSync(stateDir);
      writeFileSync(join(stateDir, ENV_FILE_NAME), 'CURSOR_API_KEY=cur_state\n');
      writeFileSync(legacyEnvFilePath, `PR_QUEST_STATE_DIR=${stateDir}\n`);

      const config = loadConfig({ env: {}, legacyEnvFilePath });

      expect(config.stateDir).toBe(stateDir);
      expect(config.cursorApiKey).toBe('cur_state');
    });
  });

  describe('local mode', () => {
    test('is the default, listening only on loopback with the default port', () => {
      const config = loadConfig({ env: {}, envFilePath });

      expect(config.mode).toBe('local');
      expect(config.host).toBe(LOOPBACK_HOST);
      expect(config.port).toBe(DEFAULT_SERVER_PORT);
      expect(config.allowedHosts).toEqual(LOOPBACK_HOSTNAMES);
      expect(config.publicOrigin).toBeUndefined();
    });

    test('accepts PR_QUEST_HOST only when it is 127.0.0.1', () => {
      expect(loadConfig({ env: { PR_QUEST_HOST: '127.0.0.1' }, envFilePath }).host).toBe(
        LOOPBACK_HOST,
      );
      expect(() => loadConfig({ env: { PR_QUEST_HOST: '0.0.0.0' }, envFilePath })).toThrow(
        /PR_QUEST_HOST/,
      );
    });

    test.each(['PR_QUEST_PUBLIC_ORIGIN', 'PR_QUEST_ALLOWED_HOSTS'])(
      'refuses %s, which would widen who may call the server',
      (name) => {
        expect(() => loadConfig({ env: { [name]: 'pr-quest.example' }, envFilePath })).toThrow(
          name,
        );
      },
    );
  });

  describe('hosted mode', () => {
    const hosted = { PR_QUEST_MODE: 'hosted', PR_QUEST_PUBLIC_ORIGIN: 'https://pr-quest.example' };

    test('listens on every interface and trusts the public origin host by default', () => {
      const config = loadConfig({ env: hosted, envFilePath });

      expect(config.mode).toBe('hosted');
      expect(config.host).toBe(HOSTED_DEFAULT_HOST);
      expect(config.publicOrigin).toBe('https://pr-quest.example');
      expect(config.allowedHosts).toEqual(['pr-quest.example']);
    });

    test('takes the host and allowed hosts from the environment', () => {
      const config = loadConfig({
        env: {
          ...hosted,
          PR_QUEST_HOST: '::',
          PR_QUEST_ALLOWED_HOSTS: ' Pr-Quest.example , pr-quest.fly.dev ,',
        },
        envFilePath,
      });

      expect(config.host).toBe('::');
      expect(config.allowedHosts).toEqual(['pr-quest.example', 'pr-quest.fly.dev']);
    });

    test('normalises a trailing slash on the public origin', () => {
      const config = loadConfig({
        env: { ...hosted, PR_QUEST_PUBLIC_ORIGIN: 'https://pr-quest.example/' },
        envFilePath,
      });

      expect(config.publicOrigin).toBe('https://pr-quest.example');
    });

    test.each(['CURSOR_API_KEY', 'ANTHROPIC_API_KEY', 'LINEAR_API_KEY'])(
      'refuses %s, which every player would share',
      (name) => {
        expect(() =>
          loadConfig({ env: { ...hosted, [name]: 'key_operator' }, envFilePath }),
        ).toThrow(name);
      },
    );

    test('requires a public origin', () => {
      expect(() => loadConfig({ env: { PR_QUEST_MODE: 'hosted' }, envFilePath })).toThrow(
        /PR_QUEST_PUBLIC_ORIGIN/,
      );
    });

    test.each(['pr-quest.example', 'ftp://pr-quest.example', 'https://pr-quest.example/app'])(
      'rejects the public origin %s',
      (origin) => {
        expect(() =>
          loadConfig({ env: { ...hosted, PR_QUEST_PUBLIC_ORIGIN: origin }, envFilePath }),
        ).toThrow(/PR_QUEST_PUBLIC_ORIGIN/);
      },
    );

    test.each(['pr-quest.example:443', 'https://pr-quest.example', 'a b'])(
      'rejects the allowed host %s',
      (host) => {
        expect(() =>
          loadConfig({ env: { ...hosted, PR_QUEST_ALLOWED_HOSTS: host }, envFilePath }),
        ).toThrow(/PR_QUEST_ALLOWED_HOSTS/);
      },
    );

    describe('the database', () => {
      const masterKey = randomBytes(32).toString('base64');
      const previous = randomBytes(32).toString('base64');
      const withDatabase = {
        ...hosted,
        DATABASE_URL: 'postgres://pr_quest@db.internal:5432/pr_quest',
        PR_QUEST_MASTER_KEY: masterKey,
      };

      test('reads the URL and the master keys', () => {
        const config = loadConfig({
          env: { ...withDatabase, PR_QUEST_PREVIOUS_MASTER_KEYS: previous },
          envFilePath,
        });
        const dataKey = newDataKey();
        const wrappedByPrevious = MasterKeyring.fromConfig({ current: previous }).wrap(
          dataKey,
          'x',
        );

        expect(config.database).toEqual({
          url: 'postgres://pr_quest@db.internal:5432/pr_quest',
          keyring: expect.any(MasterKeyring),
        });
        expect(config.database?.keyring.currentId).toBe(
          MasterKeyring.fromConfig({ current: masterKey }).currentId,
        );
        expect(config.database?.keyring.unwrap(wrappedByPrevious, 'x')).toEqual(dataKey);
      });

      test('never shows the master keys when the config is logged or serialised', () => {
        const config = loadConfig({
          env: { ...withDatabase, PR_QUEST_PREVIOUS_MASTER_KEYS: previous },
          envFilePath,
        });

        for (const shown of [
          JSON.stringify(config),
          inspect(config, { depth: Infinity, showHidden: true }),
        ]) {
          for (const key of [masterKey, previous]) {
            expect(shown).not.toContain(key);
            expect(shown).not.toContain(Buffer.from(key, 'base64').toString('hex'));
          }
          expect(shown).not.toMatch(/Buffer/);
        }
      });

      test('reads the pool size', () => {
        const env = { ...withDatabase, PR_QUEST_DATABASE_POOL_MAX: '4' };

        expect(loadConfig({ env, envFilePath }).database?.poolMax).toBe(4);
      });

      test.each(['0', '101', 'ten'])('refuses the pool size %j', (poolMax) => {
        const env = { ...withDatabase, PR_QUEST_DATABASE_POOL_MAX: poolMax };

        expect(() => loadConfig({ env, envFilePath })).toThrow(/PR_QUEST_DATABASE_POOL_MAX/);
      });

      test('is optional, for a server given its storage in code', () => {
        expect(loadConfig({ env: hosted, envFilePath }).database).toBeUndefined();
      });

      test('requires a master key to encrypt the API keys with', () => {
        const { PR_QUEST_MASTER_KEY: _omitted, ...env } = withDatabase;

        expect(() => loadConfig({ env, envFilePath })).toThrow(/PR_QUEST_MASTER_KEY is required/);
      });

      test('refuses a malformed master key without echoing it', () => {
        const env = { ...withDatabase, PR_QUEST_MASTER_KEY: 'c2hvcnQta2V5' };

        expect(() => loadConfig({ env, envFilePath })).toThrow(/32 random bytes/);
        expect(() => loadConfig({ env, envFilePath })).not.toThrow(/c2hvcnQta2V5/);
      });

      test('refuses a non-Postgres URL', () => {
        expect(() =>
          loadConfig({ env: { ...withDatabase, DATABASE_URL: 'mysql://db/x' }, envFilePath }),
        ).toThrow(/DATABASE_URL/);
      });
    });
  });

  test('local mode ignores DATABASE_URL, which other tools on the machine may set', () => {
    const config = loadConfig({
      env: { DATABASE_URL: 'postgres://elsewhere/db', PR_QUEST_MASTER_KEY: 'x' },
      envFilePath,
    });

    expect(config.database).toBeUndefined();
  });

  test('rejects an unknown mode', () => {
    expect(() => loadConfig({ env: { PR_QUEST_MODE: 'cloud' }, envFilePath })).toThrow(
      /PR_QUEST_MODE/,
    );
  });
});

describe('assertSafeConfig', () => {
  test('accepts lower-case allowed hosts in hosted mode', () => {
    expect(() => assertSafeConfig(HOSTED_CONFIG)).not.toThrow();
  });

  test.each(['Pr-Quest.example', 'pr-quest.example:443', 'https://pr-quest.example', ''])(
    'refuses the hosted allowed host "%s", which the Host check would never match',
    (name) => {
      expect(() => assertSafeConfig({ ...HOSTED_CONFIG, allowedHosts: [name] })).toThrow(
        /lower-case host names/,
      );
    },
  );
});

describe('assertSafeConfig with a database', () => {
  const masterKey = randomBytes(32).toString('base64');
  const database = {
    url: 'postgres://pr_quest@db.internal:5432/pr_quest',
    keyring: MasterKeyring.fromConfig({ current: masterKey }),
  };

  test('accepts a hosted config with a Postgres URL and a master keyring', () => {
    expect(() => assertSafeConfig({ ...HOSTED_CONFIG, database })).not.toThrow();
  });

  test('refuses a hosted config with a plain master key instead of a keyring, without echoing it', () => {
    const config: AppConfig = Object.assign(
      { ...HOSTED_CONFIG },
      { database: { url: database.url, masterKey } },
    );

    expect(() => assertSafeConfig(config)).toThrow(/MasterKeyring\.fromConfig/);
    expect(() => assertSafeConfig(config)).not.toThrow(masterKey);
  });

  test('refuses a hosted config with a non-Postgres URL', () => {
    expect(() =>
      assertSafeConfig({ ...HOSTED_CONFIG, database: { ...database, url: 'mysql://db/x' } }),
    ).toThrow(/DATABASE_URL/);
  });

  test('refuses a database in local mode, which keeps its state in files', () => {
    const local: AppConfig = Object.assign({ ...LOCAL_CONFIG }, { database });

    expect(() => assertSafeConfig(local)).toThrow(/hosted mode/);
  });
});
