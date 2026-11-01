import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  DEFAULT_GITHUB_CLIENT_ID,
  DEFAULT_SERVER_PORT,
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
  });

  test('rejects an unknown mode', () => {
    expect(() => loadConfig({ env: { PR_QUEST_MODE: 'cloud' }, envFilePath })).toThrow(
      /PR_QUEST_MODE/,
    );
  });
});
