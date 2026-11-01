import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import {
  ensurePrivateDir,
  readIfExists,
  refuseNewerVersion,
  safeJson,
  writePrivateJson,
  WriteQueue,
} from '../platform/server/privateFiles.ts';
import {
  FileSecretStore,
  SECRET_NAMES,
  type SecretName,
  type SecretStore,
} from '../platform/server/secrets.ts';

/** The encrypted secrets, next to the plain `secrets.json` that the CLI uses. */
export const ENCRYPTED_SECRETS_FILE = 'secrets.encrypted.json';
const PLAIN_SECRETS_FILE = 'secrets.json';
/** The plain copy earlier desktop builds kept after moving it into the keychain. */
const LEGACY_BACKUP_FILE = 'secrets.json.bak';

/** The part of Electron's `safeStorage` this needs, so tests can stand in for the OS keychain. */
export interface Encryptor {
  encryptString: (plainText: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
}

/**
 * Whether safeStorage protects anything here. Without a keyring, Linux "encrypts" with a fixed
 * built-in password (`basic_text`), which is no safer than the plain file.
 */
export function keychainUsable(options: {
  platform: NodeJS.Platform;
  isAvailable: boolean;
  /** `safeStorage.getSelectedStorageBackend()`, which only Linux has. */
  backend?: string;
}): boolean {
  if (!options.isAvailable) {
    return false;
  }
  return (
    options.platform !== 'linux' ||
    (options.backend !== 'basic_text' && options.backend !== 'unknown')
  );
}

export interface DesktopSecretsOptions {
  /** The OS keychain, or `undefined` when it can't be used, as on Linux without a keyring. */
  encryptor: Encryptor | undefined;
  /** Without a keychain, keep saved keys in plain `secrets.json`, which the player agreed to. */
  allowPlaintext: boolean;
  info: (message: string) => void;
  warn: (message: string) => void;
}

/**
 * Where saved keys go:
 * - `keychain`: encrypted in `secrets.encrypted.json`.
 * - `plaintext`: no keychain, so plain `secrets.json`, as the player agreed.
 * - `memory`: no keychain, so they last only until the app quits.
 * - `locked`: encrypted keys exist but the keychain is gone, so the app starts without them, keeps
 *   new ones in memory and leaves both files alone.
 * - `undecryptable`: the keychain couldn't read the encrypted file. The app starts without saved
 *   keys and leaves the file alone until a key is saved, which replaces it.
 */
export type SecretsStorage = 'keychain' | 'plaintext' | 'memory' | 'locked' | 'undecryptable';

export interface DesktopSecrets {
  store: SecretStore;
  storage: SecretsStorage;
}

/** Each value is the base64 of its `safeStorage` ciphertext. */
const EncryptedFileSchema = z.object({
  version: z.literal(1),
  secrets: z.partialRecord(z.enum(SECRET_NAMES), z.string()),
});

type Secrets = Partial<Record<SecretName, string>>;

/** The desktop app's secrets; see `SecretsStorage` for where they go. */
export async function openDesktopSecrets(
  stateDir: string,
  options: DesktopSecretsOptions,
): Promise<DesktopSecrets> {
  await ensurePrivateDir(stateDir);
  const encryptedFile = join(stateDir, ENCRYPTED_SECRETS_FILE);
  const encryptedText = await readIfExists(encryptedFile);
  if (options.encryptor === undefined) {
    return openWithoutKeychain(stateDir, encryptedText !== undefined, options);
  }

  const plainFile = join(stateDir, PLAIN_SECRETS_FILE);
  let secrets: Secrets = {};
  if (encryptedText !== undefined) {
    const decrypted = decrypt(encryptedFile, encryptedText, options.encryptor);
    if (decrypted === undefined) {
      // Someone denied keychain access, or the file came from another computer or user. It may
      // decrypt again once the keychain allows it, so nothing touches it until a key is saved.
      options.warn(
        `The OS keychain couldn't decrypt your saved keys in ${encryptedFile}, so PR Quest starts without them. Saving a key replaces that file.`,
      );
      return {
        store: new KeychainSecretStore(encryptedFile, options.encryptor, {}),
        storage: 'undecryptable',
      };
    }
    secrets = decrypted;
    await removeLegacyBackup(stateDir, options.info);
  }

  const store = new KeychainSecretStore(encryptedFile, options.encryptor, secrets);
  if ((await readIfExists(plainFile)) !== undefined) {
    await store.importPlain(stateDir, encryptedText === undefined, options);
  }
  return { store, storage: 'keychain' };
}

async function openWithoutKeychain(
  stateDir: string,
  encryptedExists: boolean,
  options: DesktopSecretsOptions,
): Promise<DesktopSecrets> {
  if (encryptedExists) {
    options.warn(
      `Your saved keys are encrypted with the OS keychain, which isn't available, so PR Quest starts without them. Keys you save now last only until PR Quest quits.`,
    );
    return { store: new MemorySecretStore({}), storage: 'locked' };
  }
  const plain = await FileSecretStore.open(stateDir, { onWarning: options.warn });
  if (options.allowPlaintext) {
    options.warn(
      `The OS keychain isn't available, so saved keys are stored unencrypted in ${join(stateDir, PLAIN_SECRETS_FILE)}, as you chose`,
    );
    return { store: plain, storage: 'plaintext' };
  }
  options.warn("The OS keychain isn't available, so keys you save last only until PR Quest quits");
  return { store: new MemorySecretStore(valuesOf(plain)), storage: 'memory' };
}

class KeychainSecretStore implements SecretStore {
  private readonly file: string;
  private readonly encryptor: Encryptor;
  private readonly writes = new WriteQueue();
  private secrets: Secrets;

  public constructor(file: string, encryptor: Encryptor, secrets: Secrets) {
    this.file = file;
    this.encryptor = encryptor;
    this.secrets = secrets;
  }

  public get(name: SecretName): string | undefined {
    return this.secrets[name];
  }

  public set(name: SecretName, value: string): Promise<void> {
    return this.write((secrets) => ({ ...secrets, [name]: value }));
  }

  public delete(name: SecretName): Promise<void> {
    if (this.secrets[name] === undefined) {
      return Promise.resolve();
    }
    return this.write((secrets) => {
      const next = { ...secrets };
      delete next[name];
      return next;
    });
  }

  /**
   * Moves the keys in `secrets.json` in, over any it has: the first run's keys, or newer ones the
   * CLI saved since. The plain file is deleted only once the encrypted copy reads back the same.
   */
  public async importPlain(
    stateDir: string,
    firstMove: boolean,
    log: Pick<DesktopSecretsOptions, 'info' | 'warn'>,
  ): Promise<void> {
    const plainFile = join(stateDir, PLAIN_SECRETS_FILE);
    // An unreadable secrets.json is moved aside here, so it never reaches the keychain.
    const plain = valuesOf(await FileSecretStore.open(stateDir, { onWarning: log.warn }));
    const next = { ...this.secrets, ...plain };
    await this.writes.run(async () => {
      const payload = this.encrypt(next);
      const unchanged = `so ${plainFile} is unchanged`;
      const readBack = decrypt(this.file, JSON.stringify(payload), this.encryptor);
      if (readBack === undefined || !sameSecrets(readBack, next)) {
        throw new Error(`The OS keychain didn't decrypt the keys it encrypted, ${unchanged}`);
      }
      await writePrivateJson(this.file, payload);
      const written = safeJson((await readIfExists(this.file)) ?? '');
      if (JSON.stringify(written) !== JSON.stringify(payload)) {
        throw new Error(`${this.file} doesn't hold the keys PR Quest just wrote, ${unchanged}`);
      }
      this.secrets = next;
    });
    await rm(plainFile, { force: true });
    log.info(
      firstMove
        ? `Moved your saved keys into the OS keychain and deleted the unencrypted ${plainFile}`
        : `Imported the keys in ${plainFile}, such as ones the CLI saved, into the OS keychain and deleted it`,
    );
  }

  private write(mutate: (secrets: Secrets) => Secrets): Promise<void> {
    return this.writes.run(async () => {
      const next = mutate(this.secrets);
      await this.save(next);
      this.secrets = next;
    });
  }

  private async save(secrets: Secrets): Promise<void> {
    await writePrivateJson(this.file, this.encrypt(secrets));
  }

  private encrypt(secrets: Secrets): { version: 1; secrets: Record<string, string> } {
    const encrypted: Record<string, string> = {};
    for (const [name, value] of Object.entries(secrets)) {
      encrypted[name] = this.encryptor.encryptString(value).toString('base64');
    }
    return { version: 1, secrets: encrypted };
  }
}

/** Keys that last until the app quits. */
class MemorySecretStore implements SecretStore {
  private secrets: Secrets;

  public constructor(secrets: Secrets) {
    this.secrets = secrets;
  }

  public get(name: SecretName): string | undefined {
    return this.secrets[name];
  }

  public set(name: SecretName, value: string): Promise<void> {
    this.secrets = { ...this.secrets, [name]: value };
    return Promise.resolve();
  }

  public delete(name: SecretName): Promise<void> {
    const next = { ...this.secrets };
    delete next[name];
    this.secrets = next;
    return Promise.resolve();
  }
}

/** The decrypted secrets, or `undefined` when the file is unreadable or won't decrypt. */
function decrypt(file: string, text: string, encryptor: Encryptor): Secrets | undefined {
  const json = safeJson(text);
  refuseNewerVersion(json, 1, file);
  const parsed = EncryptedFileSchema.safeParse(json);
  if (!parsed.success) {
    return undefined;
  }
  const secrets: Secrets = {};
  try {
    for (const name of SECRET_NAMES) {
      const value = parsed.data.secrets[name];
      if (value !== undefined) {
        secrets[name] = encryptor.decryptString(Buffer.from(value, 'base64'));
      }
    }
  } catch {
    return undefined;
  }
  return secrets;
}

function valuesOf(store: SecretStore): Secrets {
  const secrets: Secrets = {};
  for (const name of SECRET_NAMES) {
    const value = store.get(name);
    if (value !== undefined) {
      secrets[name] = value;
    }
  }
  return secrets;
}

function sameSecrets(a: Secrets, b: Secrets): boolean {
  return SECRET_NAMES.every((name) => a[name] === b[name]);
}

async function removeLegacyBackup(
  stateDir: string,
  info: (message: string) => void,
): Promise<void> {
  const backup = join(stateDir, LEGACY_BACKUP_FILE);
  if ((await readIfExists(backup)) !== undefined) {
    await rm(backup, { force: true });
    info(`Deleted ${backup}, the unencrypted copy an earlier PR Quest kept of your saved keys`);
  }
}
