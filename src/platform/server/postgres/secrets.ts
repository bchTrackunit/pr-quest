import { z } from 'zod';

import { type MasterKeyring, newDataKey, openSealed, seal } from '../envelope.ts';
import type { GitHubUser } from '../githubUser.ts';
import { WriteQueue } from '../privateFiles.ts';
import {
  SECRET_NAMES,
  type SecretName,
  type SecretStore,
  type SecretStoreOptions,
} from '../secrets.ts';
import { BytesSchema, type Database, rowsOf, type SqlClient } from './database.ts';
import { userLabel } from './documents.ts';

const DataKeyRowSchema = z.object({
  github_id: z.string().transform(Number),
  version: z.number().int().positive(),
  master_key_id: z.string(),
  wrapped_key: BytesSchema,
});

type DataKeyRow = z.infer<typeof DataKeyRowSchema>;

const SecretRowSchema = DataKeyRowSchema.extend({
  name: z.enum(SECRET_NAMES),
  sealed: BytesSchema,
});

interface DataKey {
  version: number;
  key: Buffer;
}

/**
 * Binds a wrapped data key to its account and version. The account is its GitHub id, never the
 * login, which another account can take over.
 */
const dataKeyContext = (githubId: number, version: number): string =>
  `user:${githubId}:data-key:${version}`;
/** Binds a sealed secret to its account and name, so it can't be moved to another row. */
const secretContext = (githubId: number, name: SecretName): string =>
  `user:${githubId}:secret:${name}`;

const DATA_KEY_COLUMNS = 'github_id::text AS github_id, version, master_key_id, wrapped_key';

/**
 * One user's secrets in `user_secrets`, each sealed with the user's data key, which the master key
 * wraps (see `envelope.ts`). Values are decrypted once on open and held in this process, never
 * logged or returned to the UI. A data key wrapped by a previous master key is rewrapped on open.
 */
export class PostgresSecretStore implements SecretStore {
  private readonly db: Database;
  private readonly user: GitHubUser;
  private readonly keyring: MasterKeyring;
  private readonly writes = new WriteQueue();
  /** `#private`, so inspecting or serialising the store shows neither the values nor the key. */
  readonly #secrets: Map<SecretName, string>;
  #dataKey: DataKey | undefined;

  private constructor(
    db: Database,
    user: GitHubUser,
    keyring: MasterKeyring,
    secrets: Map<SecretName, string>,
  ) {
    this.db = db;
    this.user = user;
    this.keyring = keyring;
    this.#secrets = secrets;
  }

  /**
   * `user` must already be in `users` (see `ensureUser`). Throws when `keyring` can't unwrap a data
   * key, as for a master key that isn't configured. A single secret that doesn't decrypt is
   * reported to `onWarning` and treated as unset, so saving it again replaces it.
   */
  public static async open(
    db: Database,
    user: GitHubUser,
    keyring: MasterKeyring,
    options: SecretStoreOptions = {},
  ): Promise<PostgresSecretStore> {
    const onWarning = options.onWarning ?? (() => undefined);
    const rows = rowsOf(
      await db.query(
        `SELECT s.name, s.sealed, k.github_id::text AS github_id, k.version, k.master_key_id,
                k.wrapped_key
         FROM user_secrets s
         JOIN user_data_keys k ON k.github_id = s.github_id AND k.version = s.data_key_version
         WHERE s.github_id = $1`,
        [user.id],
      ),
      SecretRowSchema,
    );
    const keys = new Map<number, Buffer>();
    const secrets = new Map<SecretName, string>();
    for (const row of rows) {
      let key = keys.get(row.version);
      if (!key) {
        key = await unwrapDataKey(db, keyring, row);
        keys.set(row.version, key);
      }
      try {
        secrets.set(row.name, openSealed(key, row.sealed, secretContext(user.id, row.name)));
      } catch {
        onWarning(
          `${userLabel(user)}'s ${row.name} key could not be decrypted, so it counts as unset until it is saved again`,
        );
      }
    }
    return new PostgresSecretStore(db, user, keyring, secrets);
  }

  public get(name: SecretName): string | undefined {
    return this.#secrets.get(name);
  }

  public set(name: SecretName, value: string): Promise<void> {
    return this.writes.run(async () => {
      const dataKey = await this.db.transaction(async (tx) => {
        const current = this.#dataKey ?? (await latestDataKey(tx, this.user.id, this.keyring));
        await tx.query(
          `INSERT INTO user_secrets (github_id, name, data_key_version, sealed)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (github_id, name) DO UPDATE
             SET data_key_version = EXCLUDED.data_key_version, sealed = EXCLUDED.sealed,
                 updated_at = now()`,
          [
            this.user.id,
            name,
            current.version,
            seal(current.key, value, secretContext(this.user.id, name)),
          ],
        );
        return current;
      });
      this.#dataKey = dataKey;
      this.#secrets.set(name, value);
    });
  }

  public delete(name: SecretName): Promise<void> {
    return this.writes.run(async () => {
      await this.db.query('DELETE FROM user_secrets WHERE github_id = $1 AND name = $2', [
        this.user.id,
        name,
      ]);
      this.#secrets.delete(name);
    });
  }
}

/**
 * Rewraps every data key that a previous master key wrapped, so that key can be retired. Resolves
 * to how many it rewrapped; running it again rewraps none.
 */
export async function rewrapDataKeys(
  db: Database,
  keyring: MasterKeyring,
): Promise<{ rewrapped: number }> {
  const rows = rowsOf(
    await db.query(`SELECT ${DATA_KEY_COLUMNS} FROM user_data_keys WHERE master_key_id <> $1`, [
      keyring.currentId,
    ]),
    DataKeyRowSchema,
  );
  let rewrapped = 0;
  for (const row of rows) {
    rewrapped += await rewrap(db, keyring, row, keyring.unwrap(wrappedOf(row), contextOf(row)));
  }
  return { rewrapped };
}

/** The user's newest data key, creating version 1 when they have none yet. */
async function latestDataKey(
  tx: SqlClient,
  githubId: number,
  keyring: MasterKeyring,
): Promise<DataKey> {
  const select = async () =>
    rowsOf(
      await tx.query(
        `SELECT ${DATA_KEY_COLUMNS} FROM user_data_keys
         WHERE github_id = $1 ORDER BY version DESC LIMIT 1`,
        [githubId],
      ),
      DataKeyRowSchema,
    )[0];
  let row = await select();
  if (!row) {
    const { masterKeyId, wrapped } = keyring.wrap(newDataKey(), dataKeyContext(githubId, 1));
    // A second server creating the key at the same time wins; this one then uses its key.
    await tx.query(
      `INSERT INTO user_data_keys (github_id, version, master_key_id, wrapped_key)
       VALUES ($1, 1, $2, $3) ON CONFLICT (github_id, version) DO NOTHING`,
      [githubId, masterKeyId, wrapped],
    );
    row = await select();
  }
  if (!row) {
    throw new Error(`Could not create a data key for GitHub id ${githubId}`);
  }
  return { version: row.version, key: await unwrapDataKey(tx, keyring, row) };
}

async function unwrapDataKey(
  db: SqlClient,
  keyring: MasterKeyring,
  row: DataKeyRow,
): Promise<Buffer> {
  const key = keyring.unwrap(wrappedOf(row), contextOf(row));
  if (!keyring.isCurrent(row.master_key_id)) {
    await rewrap(db, keyring, row, key);
  }
  return key;
}

/** Wraps `key` with the current master key, unless another process changed the row meanwhile. */
async function rewrap(
  db: SqlClient,
  keyring: MasterKeyring,
  row: DataKeyRow,
  key: Buffer,
): Promise<number> {
  const { masterKeyId, wrapped } = keyring.wrap(key, contextOf(row));
  const result = await db.query(
    `UPDATE user_data_keys SET master_key_id = $3, wrapped_key = $4, rewrapped_at = now()
     WHERE github_id = $1 AND version = $2 AND master_key_id = $5`,
    [row.github_id, row.version, masterKeyId, wrapped, row.master_key_id],
  );
  return result.rowCount;
}

const wrappedOf = (row: DataKeyRow) => ({
  masterKeyId: row.master_key_id,
  wrapped: row.wrapped_key,
});
const contextOf = (row: DataKeyRow): string => dataKeyContext(row.github_id, row.version);
