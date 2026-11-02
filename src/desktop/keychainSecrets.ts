import { rm, stat } from 'node:fs/promises';
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
 * - `memory`: no keychain, so new keys last only until the app quits. Keys in `secrets.json` are
 *   read, and deleting one removes it from there too, so signing out lasts.
 * - `locked`: encrypted keys exist but the keychain is gone, so the app starts without them, keeps
 *   new ones in memory and leaves both files alone.
 * - `undecryptable`: the keychain couldn't read the encrypted file. The app starts without saved
 *   keys and leaves the file alone until a key is saved, which replaces it.
 * - `corrupt`: the encrypted file isn't valid, and is handled as `undecryptable` is.
 * - `importFailed`: the encrypted copy of `secrets.json` didn't check out, so the app starts
 *   without saved keys, keeps new ones in memory and leaves both files alone.
 */
export type SecretsStorage =
  | 'keychain'
  | 'plaintext'
  | 'memory'
  | 'locked'
  | 'undecryptable'
  | 'corrupt'
  | 'importFailed';

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
  let encryptedSavedAt: number | undefined;
  if (encryptedText !== undefined) {
    const decrypted = decrypt(encryptedFile, encryptedText, options.encryptor);
    if (decrypted !== 'corrupt' && decrypted !== 'undecryptable') {
      secrets = decrypted;
    } else {
      // Someone denied keychain access, the file came from another computer or user, or it was
      // damaged. It may read again once that's fixed, so nothing touches it until a key is saved.
      options.warn(
        decrypted === 'corrupt'
          ? `Your saved keys in ${encryptedFile} are damaged, so PR Quest starts without them. Saving a key replaces that file.`
          : `The OS keychain couldn't decrypt your saved keys in ${encryptedFile}, so PR Quest starts without them. Saving a key replaces that file.`,
      );
      return {
        store: new KeychainSecretStore(encryptedFile, options.encryptor, {}),
        storage: decrypted,
      };
    }
    encryptedSavedAt = (await stat(encryptedFile)).mtimeMs;
    await removeLegacyBackup(stateDir, options.info);
  }

  const store = new KeychainSecretStore(encryptedFile, options.encryptor, secrets);
  if ((await readIfExists(plainFile)) !== undefined) {
    try {
      await store.importPlain(stateDir, encryptedSavedAt, options);
    } catch (error) {
      if (!(error instanceof ImportCheckFailed)) {
        throw error;
      }
      options.warn(`${error.message}. PR Quest starts without saved keys.`);
      return { store: new MemorySecretStore({}), storage: 'importFailed' };
    }
  }
  return { store, storage: 'keychain' };
}

/** The keychain's copy of the keys in `secrets.json` didn't read back the same. */
class ImportCheckFailed extends Error {}

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
  return { store: new MemorySecretStore(valuesOf(plain), plain), storage: 'memory' };
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
   * Moves the keys in `secrets.json` in: all of them on the first run (`encryptedSavedAt` is
   * undefined); later, such as after the CLI saved some, they replace the encrypted ones only if
   * the plain file is newer, and otherwise only fill in missing ones. The plain file is deleted
   * only once the encrypted copy reads back the same.
   */
  public async importPlain(
    stateDir: string,
    encryptedSavedAt: number | undefined,
    log: Pick<DesktopSecretsOptions, 'info' | 'warn'>,
  ): Promise<void> {
    const plainFile = join(stateDir, PLAIN_SECRETS_FILE);
    const plainIsNewer =
      encryptedSavedAt === undefined || (await stat(plainFile)).mtimeMs > encryptedSavedAt;
    // An unreadable secrets.json is moved aside here, so it never reaches the keychain.
    const plain = valuesOf(await FileSecretStore.open(stateDir, { onWarning: log.warn }));
    const conflicting = SECRET_NAMES.filter(
      (name) =>
        plain[name] !== undefined &&
        this.secrets[name] !== undefined &&
        plain[name] !== this.secrets[name],
    );
    const next = plainIsNewer ? { ...this.secrets, ...plain } : { ...plain, ...this.secrets };
    await this.writes.run(async () => {
      const payload = this.encrypt(next);
      const unchanged = `so ${plainFile} is unchanged`;
      const readBack = decrypt(this.file, JSON.stringify(payload), this.encryptor);
      if (typeof readBack === 'string' || !sameSecrets(readBack, next)) {
        throw new ImportCheckFailed(
          `The OS keychain didn't decrypt the keys it encrypted, ${unchanged}`,
        );
      }
      await writePrivateJson(this.file, payload);
      const written = safeJson((await readIfExists(this.file)) ?? '');
      if (JSON.stringify(written) !== JSON.stringify(payload)) {
        throw new ImportCheckFailed(
          `${this.file} doesn't hold the keys PR Quest just wrote, ${unchanged}`,
        );
      }
      this.secrets = next;
    });
    await rm(plainFile, { force: true });
    if (encryptedSavedAt === undefined) {
      log.info(
        `Moved your saved keys into the OS keychain and deleted the unencrypted ${plainFile}`,
      );
      return;
    }
    const conflicts =
      conflicting.length === 0
        ? ''
        : plainIsNewer
          ? `; being newer, it replaced ${conflicting.join(', ')}`
          : `; being older, it kept the encrypted ${conflicting.join(', ')}`;
    log.info(
      `Imported the keys in ${plainFile}, such as ones the CLI saved, into the OS keychain and deleted it${conflicts}`,
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

/**
 * Keys that last until the app quits. A key deleted here is deleted from `plain` too, the
 * `secrets.json` they were read from, or it would be back on the next start.
 */
class MemorySecretStore implements SecretStore {
  private secrets: Secrets;
  private readonly plain: SecretStore | undefined;

  public constructor(secrets: Secrets, plain?: SecretStore) {
    this.secrets = secrets;
    this.plain = plain;
  }

  public get(name: SecretName): string | undefined {
    return this.secrets[name];
  }

  public set(name: SecretName, value: string): Promise<void> {
    this.secrets = { ...this.secrets, [name]: value };
    return Promise.resolve();
  }

  public async delete(name: SecretName): Promise<void> {
    const next = { ...this.secrets };
    delete next[name];
    this.secrets = next;
    if (this.plain?.get(name) !== undefined) {
      await this.plain.delete(name);
    }
  }
}

/** The decrypted secrets, or why there are none. */
function decrypt(
  file: string,
  text: string,
  encryptor: Encryptor,
): Secrets | 'corrupt' | 'undecryptable' {
  const json = safeJson(text);
  refuseNewerVersion(json, 1, file);
  const parsed = EncryptedFileSchema.safeParse(json);
  if (!parsed.success) {
    return 'corrupt';
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
    return 'undecryptable';
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
