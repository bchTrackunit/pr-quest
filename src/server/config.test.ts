import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  DEFAULT_GITHUB_CLIENT_ID,
  DEFAULT_SERVER_PORT,
  loadConfig,
  SERVER_HOST,
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

  test('always binds to loopback and defaults the port', () => {
    const config = loadConfig({ env: {}, envFilePath });

    expect(config.host).toBe(SERVER_HOST);
    expect(config.port).toBe(DEFAULT_SERVER_PORT);
  });

  test('rejects an invalid port', () => {
    expect(() => loadConfig({ env: { PR_QUEST_PORT: 'abc' }, envFilePath })).toThrow(
      /PR_QUEST_PORT/,
    );
  });
});
