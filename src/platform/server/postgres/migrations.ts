import { z } from 'zod';

import { type Database, rowsOf } from './database.ts';

/**
 * One forward-only schema change. Statements run in order in one transaction, with the migration's
 * row in `schema_migrations`, so a failed migration leaves nothing behind. Never edit a migration
 * that has shipped; add a new one.
 */
export interface Migration {
  id: string;
  statements: ReadonlyArray<string>;
}

/** Every migration, oldest first. */
export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    id: '0001_users_documents_secrets',
    statements: [
      `CREATE TABLE users (
        login text PRIMARY KEY CHECK (login = lower(login)),
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      // One JSON document per user and kind (settings, game, quests), at the codec's `version`.
      `CREATE TABLE user_documents (
        login text NOT NULL REFERENCES users (login) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind ~ '^[a-z][a-z-]*$'),
        body jsonb NOT NULL,
        revision integer NOT NULL CHECK (revision > 0),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (login, kind)
      )`,
      // Documents this build couldn't read, kept instead of overwritten.
      `CREATE TABLE user_documents_quarantine (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        login text NOT NULL REFERENCES users (login) ON DELETE CASCADE,
        kind text NOT NULL,
        body jsonb NOT NULL,
        quarantined_at timestamptz NOT NULL DEFAULT now()
      )`,
      // Each user's data keys, wrapped by a master key. The highest version seals new secrets.
      `CREATE TABLE user_data_keys (
        login text NOT NULL REFERENCES users (login) ON DELETE CASCADE,
        version integer NOT NULL CHECK (version > 0),
        master_key_id text NOT NULL,
        wrapped_key bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        rewrapped_at timestamptz,
        PRIMARY KEY (login, version)
      )`,
      `CREATE TABLE user_secrets (
        login text NOT NULL,
        name text NOT NULL CHECK (name IN ('github', 'cursor', 'anthropic', 'linear')),
        data_key_version integer NOT NULL,
        sealed bytea NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (login, name),
        FOREIGN KEY (login, data_key_version)
          REFERENCES user_data_keys (login, version) ON DELETE CASCADE
      )`,
    ],
  },
];

/** Serialises migrators across processes; any constant works as long as it never changes. */
const MIGRATION_LOCK = 7_291_843_101;

const CREATE_LEDGER = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

const IdRowSchema = z.object({ id: z.string() });
const PresentRowSchema = z.object({ present: z.boolean() });

export interface SchemaStatus {
  /** Migrations this build has that the database hasn't run yet. */
  pending: Array<string>;
  /** Migrations the database has run that this build doesn't know: a newer build ran them. */
  unknown: Array<string>;
}

/** Runs every pending migration and resolves to the ids it ran. Safe to run from several processes. */
export async function migrate(
  db: Database,
  migrations: ReadonlyArray<Migration> = MIGRATIONS,
): Promise<Array<string>> {
  return await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await tx.query(CREATE_LEDGER);
    const applied = rowsOf(await tx.query('SELECT id FROM schema_migrations'), IdRowSchema).map(
      (row) => row.id,
    );
    refuseUnknown(statusOf(applied, migrations).unknown);
    const ran: Array<string> = [];
    for (const migration of migrations) {
      if (applied.includes(migration.id)) {
        continue;
      }
      for (const statement of migration.statements) {
        await tx.query(statement);
      }
      await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
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
  const applied = rowsOf(await db.query('SELECT id FROM schema_migrations'), IdRowSchema);
  return statusOf(
    applied.map((row) => row.id),
    migrations,
  );
}

/** Throws unless the database has run exactly this build's migrations. */
export async function assertSchemaCurrent(
  db: Database,
  migrations: ReadonlyArray<Migration> = MIGRATIONS,
): Promise<void> {
  const { pending, unknown } = await schemaStatus(db, migrations);
  refuseUnknown(unknown);
  if (pending.length > 0) {
    throw new Error(
      `The database needs migrating (${pending.join(', ')} not run yet). Run \`node dist-server/db.js migrate\`, or \`just db-migrate\` from a checkout.`,
    );
  }
}

function statusOf(
  applied: ReadonlyArray<string>,
  migrations: ReadonlyArray<Migration>,
): SchemaStatus {
  const known = new Set(migrations.map((migration) => migration.id));
  return {
    pending: migrations.map((migration) => migration.id).filter((id) => !applied.includes(id)),
    unknown: applied.filter((id) => !known.has(id)),
  };
}

function refuseUnknown(unknown: ReadonlyArray<string>): void {
  if (unknown.length > 0) {
    throw new Error(
      `The database was migrated by a newer version of PR Quest (${unknown.join(', ')}). Deploy that version or newer.`,
    );
  }
}
