import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** The server acts as the player, so it only ever listens on loopback. */
export const SERVER_HOST = '127.0.0.1';
export const DEFAULT_SERVER_PORT = 4317;
export const DEFAULT_UI_PORT = 4318;

export const DEFAULT_ENV_FILE_PATH = fileURLToPath(new URL('../../.env.local', import.meta.url));

/**
 * The client ID of a GitHub OAuth App with Device Flow enabled, used when PR_QUEST_GITHUB_CLIENT_ID
 * isn't set. A client ID isn't secret, so a team can commit theirs here.
 */
export const DEFAULT_GITHUB_CLIENT_ID = '';

export interface AppConfig {
  linearApiKey?: string;
  cursorApiKey?: string;
  anthropicApiKey?: string;
  /** Enables "Sign in with GitHub"; without it PR Quest relies on the gh CLI's token. */
  githubClientId?: string;
  host: typeof SERVER_HOST;
  port: number;
  uiPort: number;
  /** Directory for the local state file (XP, achievements, runs). */
  stateDir: string;
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Optional dotenv file; values in `env` take precedence over it. */
  envFilePath?: string;
}

/** Reads configuration from the process environment, then `.env.local` at the repo root. */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const envFilePath = options.envFilePath ?? DEFAULT_ENV_FILE_PATH;
  const fileEnv = existsSync(envFilePath) ? parseEnv(readFileSync(envFilePath, 'utf8')) : {};

  const read = (name: string): string | undefined => {
    const value = (env[name] ?? fileEnv[name])?.trim();
    return value ? value : undefined;
  };

  return {
    linearApiKey: read('LINEAR_API_KEY'),
    cursorApiKey: read('CURSOR_API_KEY'),
    anthropicApiKey: read('ANTHROPIC_API_KEY'),
    githubClientId: read('PR_QUEST_GITHUB_CLIENT_ID') ?? nonEmpty(DEFAULT_GITHUB_CLIENT_ID),
    host: SERVER_HOST,
    port: parsePort(read('PR_QUEST_PORT'), DEFAULT_SERVER_PORT, 'PR_QUEST_PORT'),
    uiPort: parsePort(read('PR_QUEST_UI_PORT'), DEFAULT_UI_PORT, 'PR_QUEST_UI_PORT'),
    stateDir: read('PR_QUEST_STATE_DIR') ?? join(homedir(), '.pr-quest'),
  };
}

function nonEmpty(value: string): string | undefined {
  return value || undefined;
}

function parsePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535, got "${value}"`);
  }
  return port;
}
