import { z } from 'zod';

import { type Database, rowsOf, type SqlClient } from './database.ts';

/**
 * One forward-only schema change. Every pending migration runs in a single transaction, with its
 * row in `schema_migrations`, so a failed run leaves nothing behind; that rules out statements
 * Postgres won't run in a transaction, such as `CREATE INDEX CONCURRENTLY`. Never edit a migration
 * that has shipped; add a new one.
 */
export interface Migration {
  id: string;
  statements: ReadonlyArray<string>;
  /**
   * Set when a build without this migration can no longer use the schema, for example after a
   * dropped or renamed column. It is recorded with the migration, so an older build rolled back
   * to refuses to start; without it, an older build starts and ignores what it doesn't know.
   */
  breaking?: boolean;
}

/** Every migration, oldest first. */
export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    id: '0001_users_documents_secrets',
    statements: [
      // Keyed by GitHub's numeric account id: a login can be renamed and then taken by another
      // account, which must never inherit the first one's rows. `login` is NULL once that happens.
      `CREATE TABLE users (
        github_id bigint PRIMARY KEY CHECK (github_id > 0),
        login text UNIQUE CHECK (login = lower(login)),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      // One JSON document per user and kind (settings, game, quests), at the codec's `version`.
      `CREATE TABLE user_documents (
        github_id bigint NOT NULL REFERENCES users (github_id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind ~ '^[a-z][a-z-]*$'),
        body jsonb NOT NULL,
        revision integer NOT NULL CHECK (revision > 0),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (github_id, kind)
      )`,
      // Documents this build couldn't read, kept once per revision instead of overwritten. The
      // unique key also indexes the table by user.
      `CREATE TABLE user_documents_quarantine (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        github_id bigint NOT NULL REFERENCES users (github_id) ON DELETE CASCADE,
        kind text NOT NULL,
        source_revision integer NOT NULL,
        body jsonb NOT NULL,
        quarantined_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (github_id, kind, source_revision)
      )`,
      // Each user's data keys, wrapped by a master key. The highest version seals new secrets.
      `CREATE TABLE user_data_keys (
        github_id bigint NOT NULL REFERENCES users (github_id) ON DELETE CASCADE,
        version integer NOT NULL CHECK (version > 0),
        master_key_id text NOT NULL,
        wrapped_key bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        rewrapped_at timestamptz,
        PRIMARY KEY (github_id, version)
      )`,
      // A data key that still seals a secret can't be deleted on its own; deleting the user
      // removes both.
      `CREATE TABLE user_secrets (
        github_id bigint NOT NULL REFERENCES users (github_id) ON DELETE CASCADE,
        name text NOT NULL CHECK (name IN ('github', 'cursor', 'anthropic', 'linear')),
        data_key_version integer NOT NULL,
        sealed bytea NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (github_id, name),
        FOREIGN KEY (github_id, data_key_version) REFERENCES user_data_keys (github_id, version)
      )`,
    ],
  },
];

/** Serialises migrators across processes; any constant works as long as it never changes. */
const MIGRATION_LOCK = 7_291_843_101;

const CREATE_LEDGER = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  breaking boolean NOT NULL DEFAULT false,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

const AppliedRowSchema = z.object({ id: z.string(), breaking: z.boolean() });
type AppliedRow = z.infer<typeof AppliedRowSchema>;
const PresentRowSchema = z.object({ present: z.boolean() });

export interface SchemaStatus {
  /** Migrations this build has that the database hasn't run yet. */
  pending: Array<string>;
  /** Migrations the database has run that this build doesn't know: a newer build ran them. */
  unknown: Array<string>;
  /** The `unknown` ones that were marked `breaking`, which this build can't run alongside. */
  breaking: Array<string>;
}

export interface SchemaCheckOptions {
  /** Hears about migrations from a newer build that this one can run alongside. */
  onWarning?: (message: string) => void;
}

/** Runs every pending migration and resolves to the ids it ran. Safe to run from several processes. */
export async function migrate(
  db: Database,
  migrations: ReadonlyArray<Migration> = MIGRATIONS,
): Promise<Array<string>> {
  return await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await tx.query(CREATE_LEDGER);
    const applied = await appliedMigrations(tx);
    refuseUnknown(statusOf(applied, migrations).unknown);
    const ran: Array<string> = [];
    for (const migration of migrations) {
      if (applied.some((row) => row.id === migration.id)) {
        continue;
      }
      for (const statement of migration.statements) {
        await tx.query(statement);
      }
      await tx.query('INSERT INTO schema_migrations (id, breaking) VALUES ($1, $2)', [
        migration.id,
        migration.breaking ?? false,
      ]);
      ran.push(migration.id);
    }
    return ran;
  });
}

/** How the database's schema compares with this build's migrations. Changes nothing. */
export async function schemaStatus(
  db: Database,
  migrations: ReadonlyArray<Migration> = MIGRATIONS,
): Promise<SchemaStatus> {
  const [ledger] = rowsOf(
    await db.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS present"),
    PresentRowSchema,
  );
  if (!ledger?.present) {
    return statusOf([], migrations);
  }
  return statusOf(await appliedMigrations(db), migrations);
}

/**
 * Throws unless the database has run every migration of this build. Migrations from a newer build
 * only warn, so a release can be rolled back, unless one of them is `breaking`.
 */
export async function assertSchemaCurrent(
  db: Database,
  migrations: ReadonlyArray<Migration> = MIGRATIONS,
  options: SchemaCheckOptions = {},
): Promise<void> {
  const { pending, unknown, breaking } = await schemaStatus(db, migrations);
  refuseUnknown(breaking);
  if (unknown.length > 0) {
    options.onWarning?.(
      `The database has migrations from a newer version of PR Quest (${unknown.join(', ')}). This version doesn't need them and runs anyway; deploy the newer one when you can.`,
    );
  }
  if (pending.length > 0) {
    throw new Error(
      `The database needs migrating (${pending.join(', ')} not run yet). Run \`node dist-server/db.js migrate\`, or \`just db-migrate\` from a checkout.`,
    );
  }
}

async function appliedMigrations(db: SqlClient): Promise<Array<AppliedRow>> {
  return rowsOf(
    await db.query('SELECT id, breaking FROM schema_migrations ORDER BY id'),
    AppliedRowSchema,
  );
}

function statusOf(
  applied: ReadonlyArray<AppliedRow>,
  migrations: ReadonlyArray<Migration>,
): SchemaStatus {
  const known = new Set(migrations.map((migration) => migration.id));
  const ran = new Set(applied.map((row) => row.id));
  const unknown = applied.filter((row) => !known.has(row.id));
  return {
    pending: migrations.map((migration) => migration.id).filter((id) => !ran.has(id)),
    unknown: unknown.map((row) => row.id),
    breaking: unknown.filter((row) => row.breaking).map((row) => row.id),
  };
}

function refuseUnknown(unknown: ReadonlyArray<string>): void {
  if (unknown.length > 0) {
    throw new Error(
      `The database was migrated by a newer version of PR Quest (${unknown.join(', ')}). Deploy that version or newer.`,
    );
  }
}
