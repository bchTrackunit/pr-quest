import { z } from 'zod';

import type { DocumentCodec } from '../documentCodec.ts';
import type { GitHubUser } from '../githubUser.ts';
import { refuseNewerVersion, WriteQueue } from '../privateFiles.ts';
import { type Database, rowsOf, type SqlClient } from './database.ts';

/** Which row of `user_documents`: a GitHub account and a document kind such as `game`. */
export interface DocumentKey {
  /** Rows are keyed by `user.id`; the login only names the user in warnings. */
  user: GitHubUser;
  kind: string;
}

export interface DocumentOptions {
  onWarning?: (message: string) => void;
}

const DocumentRowSchema = z.object({ body: z.unknown(), revision: z.number().int().positive() });

type DocumentRow = z.infer<typeof DocumentRowSchema>;

/** Two processes created the same document at once; the loser retries against the winner's row. */
class CreatedConcurrently extends Error {}

const MAX_ATTEMPTS = 3;

const DetachedRowSchema = z.object({ github_id: z.string().transform(Number) });

/**
 * Adds `user` to `users`, which every per-user row references, or records its new login. A login
 * held by another account id now belongs to `user`: that account's rows stay under its id, with
 * no login, until it signs in under its new one. Resolves to the id it took the login from.
 */
export async function ensureUser(
  db: Pick<Database, 'transaction'>,
  user: GitHubUser,
): Promise<{ detachedFrom?: number }> {
  return await db.transaction(async (tx) => {
    const [detached] = rowsOf(
      await tx.query(
        `UPDATE users SET login = NULL, updated_at = now() WHERE login = $2 AND github_id <> $1
         RETURNING github_id::text`,
        [user.id, user.login],
      ),
      DetachedRowSchema,
    );
    await tx.query(
      `INSERT INTO users (github_id, login) VALUES ($1, $2)
       ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login, updated_at = now()
       WHERE users.login IS DISTINCT FROM EXCLUDED.login`,
      [user.id, user.login],
    );
    return detached ? { detachedFrom: detached.github_id } : {};
  });
}

/** How warnings name a user: the login, which can change, and the id, which can't. */
export function userLabel(user: GitHubUser): string {
  return `${user.login} (GitHub id ${user.id})`;
}

/** The document's JSON, or `undefined` when there is none. */
export async function readDocument(db: SqlClient, key: DocumentKey): Promise<unknown> {
  return (await selectRow(db, key, ''))?.body;
}

/** Saves `body` whatever is there now. For caches, where the last write may simply win. */
export async function writeDocument(db: SqlClient, key: DocumentKey, body: unknown): Promise<void> {
  await db.query(
    `INSERT INTO user_documents (github_id, kind, body, revision) VALUES ($1, $2, $3::jsonb, 1)
     ON CONFLICT (github_id, kind) DO UPDATE
       SET body = EXCLUDED.body, revision = user_documents.revision + 1, updated_at = now()`,
    [key.user.id, key.kind, JSON.stringify(body)],
  );
}

/**
 * One JSON document in `user_documents`, held in memory so reads are synchronous. Updates run one
 * at a time in this process, each in a transaction that locks the row. When another process wrote
 * the row since this one last saw it, `mutate` applies to that newer value rather than overwriting
 * it, so a second server never silently loses a write. `mutate` may run more than once and should
 * only compute the next value.
 */
export class PostgresDocument<TValue> {
  private readonly db: Database;
  private readonly key: DocumentKey;
  private readonly codec: DocumentCodec<TValue>;
  private readonly onWarning: (message: string) => void;
  private readonly writes = new WriteQueue();
  private current: TValue;
  /** The revision `current` came from; 0 before the row exists. */
  private revision: number;

  private constructor(
    db: Database,
    key: DocumentKey,
    codec: DocumentCodec<TValue>,
    loaded: { value: TValue; revision: number },
    onWarning: (message: string) => void,
  ) {
    this.db = db;
    this.key = key;
    this.codec = codec;
    this.current = loaded.value;
    this.revision = loaded.revision;
    this.onWarning = onWarning;
  }

  /**
   * Loads the document, refusing one a newer build wrote and setting aside one it can't read.
   * `key.user` must already be in `users` (see `ensureUser`).
   */
  public static async open<TValue>(
    db: Database,
    key: DocumentKey,
    codec: DocumentCodec<TValue>,
    options: DocumentOptions = {},
  ): Promise<PostgresDocument<TValue>> {
    const onWarning = options.onWarning ?? (() => undefined);
    const row = await selectRow(db, key, '');
    const value = row ? await decodeRow(db, key, codec, row, onWarning) : codec.empty();
    return new PostgresDocument(db, key, codec, { value, revision: row?.revision ?? 0 }, onWarning);
  }

  public get value(): TValue {
    return this.current;
  }

  /**
   * Applies `mutate` after any pending update and saves the result before resolving. Returning the
   * value it was given skips the write. A `mutate` that throws rolls the transaction back.
   */
  public update(mutate: (current: TValue) => TValue): Promise<TValue> {
    return this.writes.run(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          const saved = await this.db.transaction((tx) => this.apply(tx, mutate));
          this.current = saved.value;
          this.revision = saved.revision;
          return saved.value;
        } catch (error) {
          if (!(error instanceof CreatedConcurrently) || attempt >= MAX_ATTEMPTS) {
            throw error;
          }
        }
      }
    });
  }

  private async apply(
    tx: SqlClient,
    mutate: (current: TValue) => TValue,
  ): Promise<{ value: TValue; revision: number }> {
    const row = await selectRow(tx, this.key, 'FOR UPDATE');
    const revision = row?.revision ?? 0;
    const base =
      row && row.revision !== this.revision
        ? await decodeRow(tx, this.key, this.codec, row, this.onWarning)
        : this.current;
    const next = mutate(base);
    if (next === base) {
      return { value: base, revision };
    }
    const body = JSON.stringify(this.codec.encode(next));
    if (row) {
      await tx.query(
        `UPDATE user_documents SET body = $3::jsonb, revision = $4, updated_at = now()
         WHERE github_id = $1 AND kind = $2`,
        [this.key.user.id, this.key.kind, body, revision + 1],
      );
    } else {
      const inserted = await tx.query(
        `INSERT INTO user_documents (github_id, kind, body, revision) VALUES ($1, $2, $3::jsonb, 1)
         ON CONFLICT (github_id, kind) DO NOTHING`,
        [this.key.user.id, this.key.kind, body],
      );
      if (inserted.rowCount === 0) {
        throw new CreatedConcurrently();
      }
    }
    return { value: next, revision: revision + 1 };
  }
}

async function selectRow(
  db: SqlClient,
  key: DocumentKey,
  lock: '' | 'FOR UPDATE',
): Promise<DocumentRow | undefined> {
  const result = await db.query(
    `SELECT body, revision FROM user_documents WHERE github_id = $1 AND kind = $2 ${lock}`,
    [key.user.id, key.kind],
  );
  return rowsOf(result, DocumentRowSchema)[0];
}

/** The row's value; an unreadable one is copied to the quarantine table and replaced by `empty`. */
async function decodeRow<TValue>(
  db: SqlClient,
  key: DocumentKey,
  codec: DocumentCodec<TValue>,
  row: DocumentRow,
  onWarning: (message: string) => void,
): Promise<TValue> {
  const source = `${userLabel(key.user)}'s ${key.kind} document`;
  refuseNewerVersion(row.body, codec.version, source, 'Deploy that version or newer.');
  const value = codec.decode(row.body);
  if (value !== undefined) {
    return value;
  }
  await db.query(
    `INSERT INTO user_documents_quarantine (github_id, kind, source_revision, body)
     VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING`,
    [key.user.id, key.kind, row.revision, JSON.stringify(row.body)],
  );
  onWarning(`${source} was unreadable; kept a copy in user_documents_quarantine and started fresh`);
  return codec.empty();
}
