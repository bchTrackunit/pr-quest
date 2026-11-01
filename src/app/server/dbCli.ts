import {
  MASTER_KEY_VARIABLE,
  MasterKeyring,
  PREVIOUS_MASTER_KEYS_VARIABLE,
} from '../../platform/server/envelope.ts';
import { connectPostgres, type Database } from '../../platform/server/postgres/database.ts';
import { migrate, schemaStatus } from '../../platform/server/postgres/migrations.ts';
import { rewrapDataKeys } from '../../platform/server/postgres/secrets.ts';

const USAGE = 'Usage: db <migrate | status | rewrap-keys>';

export interface DbCliOptions {
  /** Reads `DATABASE_URL`, and the master keys for `rewrap-keys`. */
  env: NodeJS.ProcessEnv;
  connect?: (url: string) => Database;
  out: (line: string) => void;
}

/**
 * Hosted mode's database chores, resolving to the exit code:
 * - `migrate` runs the pending schema migrations; run it before starting a new build.
 * - `status` lists them, failing while any is pending.
 * - `rewrap-keys` rewraps every data key under `PR_QUEST_MASTER_KEY`, after a rotation, so the
 *   keys in `PR_QUEST_PREVIOUS_MASTER_KEYS` can be dropped.
 */
export async function runDbCommand(args: Array<string>, options: DbCliOptions): Promise<number> {
  const { env, out } = options;
  const [command] = args;
  if (args.length !== 1 || !isCommand(command)) {
    out(USAGE);
    return 1;
  }
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    out('DATABASE_URL is required: the postgres:// connection string of the database');
    return 1;
  }
  let keyring: MasterKeyring | undefined;
  try {
    keyring = command === 'rewrap-keys' ? keyringFrom(env) : undefined;
  } catch (error) {
    out(messageOf(error));
    return 1;
  }
  const db = (options.connect ?? connectPostgres)(url);
  try {
    return await COMMANDS[command](db, out, keyring);
  } catch (error) {
    out(`Failed: ${messageOf(error)}`);
    return 1;
  } finally {
    await db.close();
  }
}

type Command = (
  db: Database,
  out: (line: string) => void,
  keyring?: MasterKeyring,
) => Promise<number>;

const COMMANDS = {
  migrate: async (db, out) => {
    const ran = await migrate(db);
    for (const id of ran) {
      out(`Ran migration ${id}`);
    }
    if (ran.length === 0) {
      out('The database schema is up to date');
    }
    return 0;
  },
  status: async (db, out) => {
    const { pending, unknown } = await schemaStatus(db);
    if (unknown.length > 0) {
      out(`Run by a newer build: ${unknown.join(', ')}`);
    }
    if (pending.length > 0) {
      out(`Pending: ${pending.join(', ')}`);
    }
    if (pending.length === 0 && unknown.length === 0) {
      out('The database schema is up to date');
    }
    return pending.length > 0 || unknown.length > 0 ? 1 : 0;
  },
  'rewrap-keys': async (db, out, keyring) => {
    if (!keyring) {
      throw new Error('rewrap-keys needs the master keys');
    }
    const { rewrapped } = await rewrapDataKeys(db, keyring);
    out(`Rewrapped ${rewrapped} data key${rewrapped === 1 ? '' : 's'} with the current master key`);
    return 0;
  },
} satisfies Record<string, Command>;

function isCommand(value: string | undefined): value is keyof typeof COMMANDS {
  return value !== undefined && Object.hasOwn(COMMANDS, value);
}

function keyringFrom(env: NodeJS.ProcessEnv): MasterKeyring {
  const current = env[MASTER_KEY_VARIABLE]?.trim();
  if (!current) {
    throw new Error(`${MASTER_KEY_VARIABLE} is required to rewrap the data keys`);
  }
  return MasterKeyring.fromConfig({ current, previous: env[PREVIOUS_MASTER_KEYS_VARIABLE] });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
