import { z } from 'zod';

import type { DocumentCodec } from '../documentCodec.ts';
import { refuseNewerVersion, WriteQueue } from '../privateFiles.ts';
import { type Database, rowsOf, type SqlClient } from './database.ts';

/** Which row of `user_documents`: a lower-cased GitHub login and a document kind such as `game`. */
export interface DocumentKey {
  login: string;
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

/** Adds `login` to `users`, which every per-user row references. */
export async function ensureUser(db: SqlClient, login: string): Promise<void> {
  await db.query('INSERT INTO users (login) VALUES ($1) ON CONFLICT (login) DO NOTHING', [login]);
}

/** The document's JSON, or `undefined` when there is none. */
export async function readDocument(db: SqlClient, key: DocumentKey): Promise<unknown> {
  return (await selectRow(db, key, ''))?.body;
}

/** Saves `body` whatever is there now. For caches, where the last write may simply win. */
export async function writeDocument(db: SqlClient, key: DocumentKey, body: unknown): Promise<void> {
  await db.query(
    `INSERT INTO user_documents (login, kind, body, revision) VALUES ($1, $2, $3::jsonb, 1)
     ON CONFLICT (login, kind) DO UPDATE
       SET body = EXCLUDED.body, revision = user_documents.revision + 1, updated_at = now()`,
    [key.login, key.kind, JSON.stringify(body)],
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

  /** Loads the document, refusing one a newer build wrote and setting aside one it can't read. */
  public static async open<TValue>(
    db: Database,
    key: DocumentKey,
    codec: DocumentCodec<TValue>,
    options: DocumentOptions = {},
  ): Promise<PostgresDocument<TValue>> {
    const onWarning = options.onWarning ?? (() => undefined);
    await ensureUser(db, key.login);
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
         WHERE login = $1 AND kind = $2`,
        [this.key.login, this.key.kind, body, revision + 1],
      );
    } else {
      const inserted = await tx.query(
        `INSERT INTO user_documents (login, kind, body, revision) VALUES ($1, $2, $3::jsonb, 1)
         ON CONFLICT (login, kind) DO NOTHING`,
        [this.key.login, this.key.kind, body],
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
    `SELECT body, revision FROM user_documents WHERE login = $1 AND kind = $2 ${lock}`,
    [key.login, key.kind],
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
  const source = `${key.login}'s ${key.kind} document`;
  refuseNewerVersion(row.body, codec.version, source, 'Deploy that version or newer.');
  const value = codec.decode(row.body);
  if (value !== undefined) {
    return value;
  }
  await db.query(
    'INSERT INTO user_documents_quarantine (login, kind, body) VALUES ($1, $2, $3::jsonb)',
    [key.login, key.kind, JSON.stringify(row.body)],
  );
  onWarning(`${source} was unreadable; kept a copy in user_documents_quarantine and started fresh`);
  return codec.empty();
}
