import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import { MASTER_KEY_VARIABLE, MasterKeyring, PREVIOUS_MASTER_KEYS_VARIABLE } from './envelope.ts';
import { readPorts, SERVER_HOST } from '@pr-quest/contract/ports';

/**
 * `local` serves one person on their own machine and acts as them, so it only listens on loopback.
 * `hosted` serves many users from a public address behind HTTPS.
 */
export type ServerMode = 'local' | 'hosted';

/** In local mode the server acts as the player, so it only ever listens here. */
export const LOOPBACK_HOST = SERVER_HOST;
export type LoopbackHost = typeof LOOPBACK_HOST;
export type LoopbackHostname = LoopbackHost | 'localhost';
/** The Host header names local mode accepts, which stops DNS rebinding. */
export const LOOPBACK_HOSTNAMES: ReadonlyArray<LoopbackHostname> = ['127.0.0.1', 'localhost'];
/** Every interface, IPv6 and (on dual-stack hosts) IPv4, as private networks such as Fly's need. */
export const HOSTED_DEFAULT_HOST = '::';
/** The env file read from the state directory. */
export const ENV_FILE_NAME = '.env';

/**
 * Every Anthropic call (reviews and the model list) goes here. `ANTHROPIC_BASE_URL` is ignored, so
 * a gateway set up for another tool never receives the key or a private diff.
 */
export const ANTHROPIC_API_URL = 'https://api.anthropic.com';

/**
 * The client ID of a GitHub OAuth App with Device Flow enabled, used when PR_QUEST_GITHUB_CLIENT_ID
 * isn't set. A client ID isn't secret, so a team can commit theirs here.
 */
export const DEFAULT_GITHUB_CLIENT_ID = '';

/** Hosted mode's Postgres database and the master keys that encrypt users' API keys in it. */
export interface DatabaseConfig {
  /** `DATABASE_URL`, a `postgres://` connection string. */
  url: string;
  /** `PR_QUEST_MASTER_KEY`: base64 of 32 random bytes. */
  masterKey: string;
  /** `PR_QUEST_PREVIOUS_MASTER_KEYS`: comma-separated keys being rotated out. */
  previousMasterKeys?: string;
  /** `PR_QUEST_DATABASE_POOL_MAX`: most connections per server process, 1 to 100; default 10. */
  poolMax?: number;
}

interface BaseConfig {
  /** Enables "Sign in with GitHub"; without it PR Quest relies on the gh CLI's token. */
  githubClientId?: string;
  /** 0 picks a free port when the server starts in-process. */
  port: number;
  uiPort: number;
  /** Directory for the local state file (XP, achievements, runs). */
  stateDir: string;
}

/** One player on their own machine. The server acts as them, so nothing but loopback may reach it. */
export interface LocalConfig extends BaseConfig {
  mode: 'local';
  linearApiKey?: string;
  cursorApiKey?: string;
  anthropicApiKey?: string;
  host: LoopbackHost;
  allowedHosts: ReadonlyArray<LoopbackHostname>;
  publicOrigin?: never;
  database?: never;
}

/** Many players behind HTTPS. Each saves their own API keys, so none come from the environment. */
export interface HostedConfig extends BaseConfig {
  mode: 'hosted';
  /** The address to listen on. */
  host: string;
  /** The origin browsers load PR Quest from, such as `https://pr-quest.example`. */
  publicOrigin: string;
  /** Lower-cased host names, without a port, that the Host header may name. */
  allowedHosts: ReadonlyArray<string>;
  linearApiKey?: never;
  cursorApiKey?: never;
  anthropicApiKey?: never;
  /** Postgres storage, from `DATABASE_URL`. Without it, the embedding app supplies the storage. */
  database?: DatabaseConfig;
}

export type AppConfig = LocalConfig | HostedConfig;

const ENV_API_KEYS = {
  cursorApiKey: 'CURSOR_API_KEY',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  linearApiKey: 'LINEAR_API_KEY',
} as const;
type ApiKeyField = keyof typeof ENV_API_KEYS;
const API_KEY_FIELDS = ['cursorApiKey', 'anthropicApiKey', 'linearApiKey'] as const;

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** The env file to read instead of `<stateDir>/.env`; values in `env` take precedence over it. */
  envFilePath?: string;
  /**
   * An older env file with the lowest precedence, such as `.env.local` at the repo root. It may set
   * `PR_QUEST_STATE_DIR`, which the state directory's own env file can't.
   */
  legacyEnvFilePath?: string;
  /** Hears about a state-directory env file that other users may read. */
  onWarning?: (message: string) => void;
}

/**
 * Reads configuration from the process environment, then the env file in the state directory,
 * then the legacy env file, if there is one.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const legacyEnv = readEnvFile(options.legacyEnvFilePath);
  const stateDir =
    pick(env.PR_QUEST_STATE_DIR ?? legacyEnv.PR_QUEST_STATE_DIR) ?? join(homedir(), '.pr-quest');
  const envFilePath = options.envFilePath ?? join(stateDir, ENV_FILE_NAME);
  const fileEnv = readEnvFile(envFilePath);
  if (options.onWarning && isShared(envFilePath)) {
    options.onWarning(
      `${envFilePath} can hold API keys but other users may read it. Run \`chmod 600 ${envFilePath}\`.`,
    );
  }
  if (fileEnv.PR_QUEST_STATE_DIR !== undefined) {
    throw new Error(
      `PR_QUEST_STATE_DIR can't be set in ${envFilePath}, which is read from the state directory. Set it in the environment instead.`,
    );
  }

  const read = (name: string): string | undefined =>
    pick(env[name] ?? fileEnv[name] ?? legacyEnv[name]);

  const base: BaseConfig = {
    githubClientId: read('PR_QUEST_GITHUB_CLIENT_ID') ?? nonEmpty(DEFAULT_GITHUB_CLIENT_ID),
    ...readPorts(read),
    stateDir,
  };
  const boundary = trustBoundary(read);
  if (boundary.mode === 'hosted') {
    for (const name of Object.values(ENV_API_KEYS)) {
      if (read(name) !== undefined) {
        throw new Error(
          `${name} can't be set in hosted mode: every player would share it. Each player saves their own key in Settings.`,
        );
      }
    }
    const database = databaseConfig(read);
    return { ...base, ...boundary, ...(database ? { database } : {}) };
  }
  return {
    ...base,
    ...boundary,
    linearApiKey: read(ENV_API_KEYS.linearApiKey),
    cursorApiKey: read(ENV_API_KEYS.cursorApiKey),
    anthropicApiKey: read(ENV_API_KEYS.anthropicApiKey),
  };
}

type TrustBoundary =
  | Pick<LocalConfig, 'mode' | 'host' | 'allowedHosts'>
  | Pick<HostedConfig, 'mode' | 'host' | 'publicOrigin' | 'allowedHosts'>;

/**
 * Checks a config built by hand, such as `{ ...loadConfig(), port: 0 }` from an embedding app,
 * where plain JavaScript can get past the types. Local mode acts as the player's GitHub account,
 * so it must listen on loopback and accept only loopback Host names.
 */
export function assertSafeConfig(config: AppConfig): void {
  const mode: string = config.mode;
  if (mode !== 'local' && mode !== 'hosted') {
    throw new Error(`mode must be "local" or "hosted", got "${mode}"`);
  }
  assertPort(config.port, 'port', 0);
  assertPort(config.uiPort, 'uiPort', 0);
  if (config.mode === 'hosted') {
    parseOrigin(config.publicOrigin);
    if (config.allowedHosts.length === 0) {
      throw new Error('Hosted mode needs at least one allowed host');
    }
    const malformed = config.allowedHosts.filter((name) => !isHostname(name));
    if (malformed.length > 0) {
      throw new Error(
        `Hosted mode's allowedHosts must be lower-case host names without a scheme or port, got ${malformed.map((name) => `"${name}"`).join(', ')}`,
      );
    }
    const keys: Partial<Record<ApiKeyField, unknown>> = config;
    const shared = API_KEY_FIELDS.filter((field) => keys[field] !== undefined);
    if (shared.length > 0) {
      throw new Error(
        `Hosted mode takes no API keys from the config (${shared.map((field) => ENV_API_KEYS[field]).join(', ')}): every player would share them`,
      );
    }
    if (config.database !== undefined) {
      assertDatabase(config.database);
    }
    return;
  }
  const host: string = config.host;
  if (host !== LOOPBACK_HOST) {
    throw new Error(`Local mode listens only on ${LOOPBACK_HOST}, got "${host}"`);
  }
  const allowedHosts: ReadonlyArray<string> = config.allowedHosts;
  const foreign = allowedHosts.filter((name) => !LOOPBACK_HOSTNAMES.some((ok) => ok === name));
  if (foreign.length > 0) {
    throw new Error(`Local mode accepts only loopback Host names, got ${foreign.join(', ')}`);
  }
  const { publicOrigin }: { publicOrigin?: unknown } = config;
  if (publicOrigin !== undefined) {
    throw new Error('Local mode has no public origin; that is hosted mode (PR_QUEST_MODE=hosted)');
  }
  const { database }: { database?: unknown } = config;
  if (database !== undefined) {
    throw new Error(
      'Local mode keeps its state in files, not a database; that is hosted mode (PR_QUEST_MODE=hosted)',
    );
  }
}

/** Local mode never reads `DATABASE_URL`, which other tools on the machine may set. */
function databaseConfig(read: (name: string) => string | undefined): DatabaseConfig | undefined {
  const url = read('DATABASE_URL');
  if (url === undefined) {
    return undefined;
  }
  const masterKey = read(MASTER_KEY_VARIABLE);
  if (masterKey === undefined) {
    throw new Error(
      `${MASTER_KEY_VARIABLE} is required with DATABASE_URL: it encrypts every user's API keys. Create one with \`openssl rand -base64 32\` and keep it in the platform's secrets.`,
    );
  }
  const previousMasterKeys = read(PREVIOUS_MASTER_KEYS_VARIABLE);
  const poolMax = read('PR_QUEST_DATABASE_POOL_MAX');
  const database: DatabaseConfig = {
    url,
    masterKey,
    ...(previousMasterKeys ? { previousMasterKeys } : {}),
    ...(poolMax === undefined ? {} : { poolMax: Number(poolMax) }),
  };
  assertDatabase(database);
  return database;
}

/** Fails at startup rather than on the first sign-in, and never echoes a key. */
function assertDatabase(database: DatabaseConfig): void {
  if (!/^postgres(?:ql)?:\/\//.test(database.url)) {
    throw new Error('DATABASE_URL must be a postgres:// connection string');
  }
  const { poolMax } = database;
  if (poolMax !== undefined && (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 100)) {
    throw new Error('PR_QUEST_DATABASE_POOL_MAX must be an integer between 1 and 100');
  }
  MasterKeyring.fromConfig({ current: database.masterKey, previous: database.previousMasterKeys });
}

/** Who may reach the server: loopback only in local mode, the public origin's hosts when hosted. */
function trustBoundary(read: (name: string) => string | undefined): TrustBoundary {
  const mode = parseMode(read('PR_QUEST_MODE'));
  const host = read('PR_QUEST_HOST');
  const publicOrigin = read('PR_QUEST_PUBLIC_ORIGIN');
  const allowedHosts = read('PR_QUEST_ALLOWED_HOSTS');

  if (mode === 'local') {
    if (host !== undefined && host !== LOOPBACK_HOST) {
      throw new Error(
        `PR_QUEST_HOST must be ${LOOPBACK_HOST} in local mode, got "${host}". Only hosted mode listens elsewhere.`,
      );
    }
    for (const [name, value] of [
      ['PR_QUEST_PUBLIC_ORIGIN', publicOrigin],
      ['PR_QUEST_ALLOWED_HOSTS', allowedHosts],
    ] as const) {
      if (value !== undefined) {
        throw new Error(`${name} only applies in hosted mode (PR_QUEST_MODE=hosted)`);
      }
    }
    return { mode: 'local', host: LOOPBACK_HOST, allowedHosts: LOOPBACK_HOSTNAMES };
  }

  if (publicOrigin === undefined) {
    throw new Error(
      'PR_QUEST_PUBLIC_ORIGIN is required in hosted mode, for example https://pr-quest.example',
    );
  }
  const origin = parseOrigin(publicOrigin);
  return {
    mode: 'hosted',
    host: host ?? HOSTED_DEFAULT_HOST,
    publicOrigin: origin.origin,
    allowedHosts: allowedHosts === undefined ? [origin.hostname] : parseAllowedHosts(allowedHosts),
  };
}

function parseMode(value: string | undefined): ServerMode {
  if (value === undefined || value === 'local' || value === 'hosted') {
    return value ?? 'local';
  }
  throw new Error(`PR_QUEST_MODE must be "local" or "hosted", got "${value}"`);
}

function parseOrigin(value: string): URL {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (
    !url ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.origin !== value.replace(/\/$/, '')
  ) {
    throw new Error(
      `PR_QUEST_PUBLIC_ORIGIN must be an http(s) origin without a path, such as https://pr-quest.example, got "${value}"`,
    );
  }
  return url;
}

function parseAllowedHosts(value: string): Array<string> {
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '')
    .map((entry) => {
      if (!isHostname(entry)) {
        throw new Error(
          `PR_QUEST_ALLOWED_HOSTS lists host names without a scheme or port, separated by commas; got "${entry}"`,
        );
      }
      return entry;
    });
}

function isHostname(value: string): boolean {
  try {
    return new URL(`http://${value}`).hostname === value;
  } catch {
    return false;
  }
}

/** Readable or writable by the group or others; Windows has no such mode bits. */
function isShared(path: string): boolean {
  return process.platform !== 'win32' && existsSync(path) && (statSync(path).mode & 0o077) !== 0;
}

function readEnvFile(path: string | undefined): NodeJS.Dict<string> {
  return path !== undefined && existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

/** A blank value counts as unset, so the default applies. */
function pick(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function nonEmpty(value: string): string | undefined {
  return value || undefined;
}

function assertPort(port: number, name: string, min: number): void {
  if (!Number.isInteger(port) || port < min || port > 65535) {
    throw new Error(`${name} must be an integer between ${min} and 65535, got "${port}"`);
  }
}
