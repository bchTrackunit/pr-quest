import { chmod, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import {
  ensurePrivateDir,
  readIfExists,
  refuseNewerVersion,
  safeJson,
  writePrivateJson,
  WriteQueue,
} from './privateFiles.ts';

const SECRETS_FILE = 'secrets.json';

/** The GitHub OAuth token plus the API keys the settings popup manages. */
export const SECRET_NAMES = ['github', 'cursor', 'anthropic', 'linear'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const SecretsFileSchema = z.object({
  version: z.literal(1),
  secrets: z.partialRecord(z.enum(SECRET_NAMES), z.string()),
});

type Secrets = Partial<Record<SecretName, string>>;

/**
 * Saved secrets. Reads are synchronous, so an implementation loads its values when it opens and
 * resolves `set` and `delete` once the change is stored. Nothing may log or return a value to the UI.
 */
export interface SecretStore {
  get: (name: SecretName) => string | undefined;
  set: (name: SecretName, value: string) => Promise<void>;
  delete: (name: SecretName) => Promise<void>;
}

export interface SecretStoreOptions {
  onWarning?: (message: string) => void;
}

/**
 * Secrets in `<stateDir>/secrets.json`: mode 0600 in a 0700 directory, written atomically. Values
 * stay in this process; nothing here logs or returns them to the UI.
 */
export class FileSecretStore implements SecretStore {
  private readonly file: string;
  private readonly writes = new WriteQueue();
  private secrets: Secrets;

  private constructor(file: string, secrets: Secrets) {
    this.file = file;
    this.secrets = secrets;
  }

  public static async open(
    stateDir: string,
    options: SecretStoreOptions = {},
  ): Promise<FileSecretStore> {
    await ensurePrivateDir(stateDir);
    const file = join(stateDir, SECRETS_FILE);
    return new FileSecretStore(
      file,
      await readSecrets(file, options.onWarning ?? (() => undefined)),
    );
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
      await writePrivateJson(this.file, { version: 1, secrets: next });
      this.secrets = next;
    });
  }
}

async function readSecrets(file: string, onWarning: (message: string) => void): Promise<Secrets> {
  const text = await readIfExists(file);
  if (text === undefined) {
    return {};
  }
  await chmod(file, 0o600);
  const json = safeJson(text);
  refuseNewerVersion(json, 1, file);
  const parsed = SecretsFileSchema.safeParse(json);
  if (parsed.success) {
    return parsed.data.secrets;
  }
  const aside = `${file}.corrupt-${Date.now()}`;
  await rename(file, aside);
  onWarning(`The secrets file was unreadable; moved it to ${aside} and started without saved keys`);
  return {};
}
