import { rename } from 'node:fs/promises';
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

/** The encrypted secrets, next to the plain `secrets.json` that the CLI and older builds use. */
export const ENCRYPTED_SECRETS_FILE = 'secrets.encrypted.json';
const PLAIN_SECRETS_FILE = 'secrets.json';

/** The part of Electron's `safeStorage` this needs, so tests can stand in for the OS keychain. */
export interface Encryptor {
  encryptString: (plainText: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
}

export interface DesktopSecretsOptions {
  /** The OS keychain, or `undefined` when it can't be used, as on Linux without a keyring. */
  encryptor: Encryptor | undefined;
  info: (message: string) => void;
  warn: (message: string) => void;
}

/** Each value is the base64 of its `safeStorage` ciphertext. */
const EncryptedFileSchema = z.object({
  version: z.literal(1),
  secrets: z.partialRecord(z.enum(SECRET_NAMES), z.string()),
});

type Secrets = Partial<Record<SecretName, string>>;

/**
 * The desktop app's secrets: encrypted with the OS keychain when there is one, otherwise the plain
 * `secrets.json`. The first run with a keychain moves the values out of `secrets.json` and keeps
 * the file as `secrets.json.bak`.
 */
export async function openDesktopSecrets(
  stateDir: string,
  options: DesktopSecretsOptions,
): Promise<SecretStore> {
  if (options.encryptor === undefined) {
    options.warn(
      `The OS keychain isn't available, so saved keys stay unencrypted in ${join(stateDir, PLAIN_SECRETS_FILE)}, which only you can read`,
    );
    return FileSecretStore.open(stateDir, { onWarning: options.warn });
  }
  return KeychainSecretStore.open(stateDir, options.encryptor, options);
}

class KeychainSecretStore implements SecretStore {
  private readonly file: string;
  private readonly encryptor: Encryptor;
  private readonly writes = new WriteQueue();
  private secrets: Secrets;

  private constructor(file: string, encryptor: Encryptor, secrets: Secrets) {
    this.file = file;
    this.encryptor = encryptor;
    this.secrets = secrets;
  }

  public static async open(
    stateDir: string,
    encryptor: Encryptor,
    log: Pick<DesktopSecretsOptions, 'info' | 'warn'>,
  ): Promise<KeychainSecretStore> {
    await ensurePrivateDir(stateDir);
    const file = join(stateDir, ENCRYPTED_SECRETS_FILE);
    const text = await readIfExists(file);
    if (text !== undefined) {
      return new KeychainSecretStore(
        file,
        encryptor,
        await decrypt(file, text, encryptor, log.warn),
      );
    }

    const plainFile = join(stateDir, PLAIN_SECRETS_FILE);
    if ((await readIfExists(plainFile)) === undefined) {
      return new KeychainSecretStore(file, encryptor, {});
    }
    const plain = await FileSecretStore.open(stateDir, { onWarning: log.warn });
    const secrets: Secrets = {};
    for (const name of SECRET_NAMES) {
      const value = plain.get(name);
      if (value !== undefined) {
        secrets[name] = value;
      }
    }
    const store = new KeychainSecretStore(file, encryptor, secrets);
    await store.writes.run(() => store.save(secrets));
    // An unreadable secrets.json has already been moved aside by FileSecretStore.
    if ((await readIfExists(plainFile)) !== undefined) {
      await rename(plainFile, `${plainFile}.bak`);
      log.info(
        `Moved your saved keys into the OS keychain. The old unencrypted copy is ${plainFile}.bak; delete it once PR Quest works.`,
      );
    }
    return store;
  }

  public get(name: SecretName): string | undefined {
    return this.secrets[name];
  }

  public set(name: SecretName, value: string): Promise<void> {
    return this.write((secrets) => ({ ...secrets, [name]: value }));
  }

  public delete(name: SecretName): Promise<void> {
    return this.write((secrets) => {
      const next = { ...secrets };
      delete next[name];
      return next;
    });
  }

  private write(mutate: (secrets: Secrets) => Secrets): Promise<void> {
    return this.writes.run(async () => {
      const next = mutate(this.secrets);
      await this.save(next);
      this.secrets = next;
    });
  }

  private async save(secrets: Secrets): Promise<void> {
    const encrypted: Record<string, string> = {};
    for (const [name, value] of Object.entries(secrets)) {
      encrypted[name] = this.encryptor.encryptString(value).toString('base64');
    }
    await writePrivateJson(this.file, { version: 1, secrets: encrypted });
  }
}

async function decrypt(
  file: string,
  text: string,
  encryptor: Encryptor,
  warn: (message: string) => void,
): Promise<Secrets> {
  const json = safeJson(text);
  refuseNewerVersion(json, 1, file);
  const parsed = EncryptedFileSchema.safeParse(json);
  if (!parsed.success) {
    warn(`The encrypted secrets file was unreadable; moved it to ${await moveAside(file)}`);
    return {};
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
    // Someone denied keychain access, or the file came from another computer or user. Keep it, as
    // it may decrypt again once the keychain allows it.
    warn(
      `The OS keychain couldn't decrypt your saved keys; moved them to ${await moveAside(file)} and started without saved keys`,
    );
    return {};
  }
  return secrets;
}

async function moveAside(file: string): Promise<string> {
  const aside = `${file}.corrupt-${Date.now()}`;
  await rename(file, aside);
  return aside;
}
