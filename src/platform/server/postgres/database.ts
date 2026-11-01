import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';

/** What a statement returned. Rows are `unknown`; parse them with a schema before use. */
export interface SqlResult {
  rows: Array<unknown>;
  rowCount: number;
}

/** Runs one parameterised statement. Pass JSON as a string with a `::jsonb` cast. */
export interface SqlClient {
  query: (text: string, params?: ReadonlyArray<unknown>) => Promise<SqlResult>;
}

/** A Postgres database: single statements, or a transaction on one connection. */
export interface Database extends SqlClient {
  /** Runs `work` in a transaction that commits when it resolves and rolls back when it rejects. */
  transaction: <TResult>(work: (tx: SqlClient) => Promise<TResult>) => Promise<TResult>;
  close: () => Promise<void>;
}

/** A database borrowed from its owner, who alone closes it. */
export type SharedDatabase = Pick<Database, 'query' | 'transaction'>;

/** `db` without `close`, to hand to code that must not end the owner's pool. */
export function sharedDatabase(db: Database): SharedDatabase {
  return {
    query: (text, params) => db.query(text, params),
    transaction: (work) => db.transaction(work),
  };
}

export interface ConnectOptions {
  /** Most connections the pool opens; defaults to 10. */
  max?: number;
  /** An idle connection failed, e.g. the server restarted. The pool replaces it. */
  onError?: (message: string) => void;
}

/** A pooled connection to `url`, a `postgres://` connection string such as `DATABASE_URL`. */
export function connectPostgres(url: string, options: ConnectOptions = {}): Database {
  const pool = new Pool({ connectionString: url, max: options.max ?? 10 });
  pool.on('error', (error) => {
    options.onError?.(`An idle database connection failed: ${error.message}`);
  });
  return poolDatabase(pool);
}

/** `pool` as a `Database`; closing it ends the pool. */
export function poolDatabase(pool: Pool): Database {
  return {
    query: (text, params) => run(pool, text, params),
    transaction: async (work) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work({ query: (text, params) => run(client, text, params) });
        await client.query('COMMIT');
        client.release();
        return result;
      } catch (error) {
        await rollback(client, error);
        throw error;
      }
    },
    close: () => pool.end(),
  };
}

async function run(
  target: Pool | PoolClient,
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<SqlResult> {
  const result = await target.query(text, [...params]);
  return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

/** Rolls back and returns the connection; one that can't roll back is closed instead of reused. */
async function rollback(client: PoolClient, cause: unknown): Promise<void> {
  try {
    await client.query('ROLLBACK');
    client.release();
  } catch {
    client.release(cause instanceof Error ? cause : true);
  }
}

/** A `bytea` column, which `pg` reads as a `Buffer` and PGlite as a `Uint8Array`. */
export const BytesSchema = z.instanceof(Uint8Array).transform((bytes) => Buffer.from(bytes));

/** Parses each row with `schema`, so a column of the wrong type fails loudly. */
export function rowsOf<TSchema extends z.ZodType>(
  result: SqlResult,
  schema: TSchema,
): Array<z.infer<TSchema>> {
  return result.rows.map((row) => schema.parse(row));
}
