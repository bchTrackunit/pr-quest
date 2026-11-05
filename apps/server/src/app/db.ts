import { runDbCommand } from './dbCli.ts';

// `node apps/server/dist/db.js <command>` in a deployment, `just db-migrate` and friends from a checkout.
void runDbCommand(process.argv.slice(2), {
  env: process.env,
  out: (line) => process.stdout.write(`[pr-quest] ${line}\n`),
  err: (line) => process.stderr.write(`[pr-quest] ${line}\n`),
}).then((code) => {
  process.exitCode = code;
});
