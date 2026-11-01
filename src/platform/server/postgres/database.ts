import { Pool } from 'pg';
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

/** The SQLSTATE of a Postgres error, such as `23505` for a unique violation. */
export function sqlStateOf(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

export interface ConnectOptions {
  /** Most connections the pool opens; defaults to 10. */
  max?: number;
  /** A connection failed, idle or mid-transaction, e.g. the server restarted. It isn't reused. */
  onError?: (message: string) => void;
}

/** What `poolConfig` sets; the `DATABASE_URL` query string overrides any of it. */
export interface PoolSettings {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
  keepAlive: boolean;
  statement_timeout: number;
  idle_in_transaction_session_timeout: number;
  application_name: string;
}

/** Bounds every wait, so an unreachable or stuck database fails a request instead of hanging it. */
export function poolConfig(url: string, options: Pick<ConnectOptions, 'max'> = {}): PoolSettings {
  return {
    connectionString: url,
    max: options.max ?? 10,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 30_000,
    application_name: 'pr-quest',
  };
}

/** A pooled connection to `url`, a `postgres://` connection string such as `DATABASE_URL`. */
export function connectPostgres(url: string, options: ConnectOptions = {}): Database {
  const pool = new Pool(poolConfig(url, options));
  pool.on('error', (error) => {
    options.onError?.(`An idle database connection failed: ${error.message}`);
  });
  return poolDatabase(pool, options.onError);
}

interface QueryResultLike {
  rows: Array<unknown>;
  rowCount: number | null;
}

/** The part of a `pg` pool connection a transaction uses. */
export interface PoolClientLike {
  query: (text: string, values?: Array<unknown>) => Promise<QueryResultLike>;
  release: (error?: Error | boolean) => void;
  on: (event: 'error', listener: (error: Error) => void) => unknown;
  off: (event: 'error', listener: (error: Error) => void) => unknown;
}

/** The part of a `pg` pool a `Database` uses. */
export interface PoolLike {
  query: (text: string, values?: Array<unknown>) => Promise<QueryResultLike>;
  connect: () => Promise<PoolClientLike>;
  end: () => Promise<void>;
}

/**
 * `pool` as a `Database`; closing it ends the pool. A connection that fails while a transaction
 * holds it is reported to `onError`, rather than crashing the process, and the transaction fails.
 */
export function poolDatabase(pool: PoolLike, onError?: (message: string) => void): Database {
  return {
    query: (text, params) => run(pool, text, params),
    transaction: async (work) => {
      const client = await pool.connect();
      const failed = (error: Error) => {
        onError?.(`A database connection failed: ${error.message}`);
      };
      client.on('error', failed);
      const release = (error?: Error | boolean) => {
        client.off('error', failed);
        client.release(error);
      };
      try {
        await client.query('BEGIN');
        const result = await work({ query: (text, params) => run(client, text, params) });
        await client.query('COMMIT');
        release();
        return result;
      } catch (error) {
        await rollback(client, release, error);
        throw error;
      }
    },
    close: () => pool.end(),
  };
}

async function run(
  target: Pick<PoolLike, 'query'>,
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<SqlResult> {
  const result = await target.query(text, [...params]);
  return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

/** Rolls back and returns the connection; one that can't roll back is closed instead of reused. */
async function rollback(
  client: PoolClientLike,
  release: (error?: Error | boolean) => void,
  cause: unknown,
): Promise<void> {
  try {
    await client.query('ROLLBACK');
    release();
  } catch {
    release(cause instanceof Error ? cause : true);
  }
}

/**
 * Host names that stay on a private network or this machine, where TLS adds little: loopback,
 * RFC 1918 addresses, Fly's private names and single-label names such as a Compose service's.
 */
const PRIVATE_HOST =
  /(\.internal|\.flycast|^localhost|^127\.\d+\.\d+\.\d+|^\[::1\]|^10\.\d+\.\d+\.\d+|^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|^192\.168\.\d+\.\d+|^[a-z\d-]+)$/i;

/**
 * A warning when `url` reaches a public host without TLS, which would send every user's sealed
 * keys and the password in the clear. Names the host only, never the URL with its password.
 */
export function transportWarning(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const sslmode = parsed.searchParams.get('sslmode');
  const ssl = parsed.searchParams.get('ssl');
  const encrypted = (sslmode !== null && sslmode !== 'disable') || ssl === 'true' || ssl === '1';
  if (encrypted || isSocketOrDefaultHost(parsed) || PRIVATE_HOST.test(parsed.hostname)) {
    return undefined;
  }
  return `DATABASE_URL reaches ${parsed.hostname} without TLS. Add ?sslmode=require (or verify-full) unless that host is on a private network.`;
}

/**
 * `socket:/dir`, `?host=/dir`, a host that is a percent-encoded directory, or no host at all
 * (`pg` then uses `PGHOST` or this machine).
 */
function isSocketOrDefaultHost(url: URL): boolean {
  let host = url.hostname;
  try {
    host = decodeURIComponent(host);
  } catch {
    // Not percent-encoded after all; keep it as it is.
  }
  return (
    url.protocol === 'socket:' ||
    host === '' ||
    url.searchParams.get('host')?.startsWith('/') === true ||
    host.startsWith('/')
  );
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
