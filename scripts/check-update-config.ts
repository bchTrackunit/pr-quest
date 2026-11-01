/*
 * Fails when a packaged app's app-update.yml would let the updater install an older version, or,
 * with --signed, an update nobody checked the signer of; see src/desktop/updateConfig.ts.
 * Usage: node scripts/check-update-config.ts <app-update.yml> [--signed]
 */
import { readFileSync } from 'node:fs';

import { updateConfigProblems } from '../src/desktop/updateConfig.ts';

const [file, ...flags] = process.argv.slice(2);
if (file === undefined || flags.some((flag) => flag !== '--signed')) {
  process.stderr.write('usage: node scripts/check-update-config.ts <app-update.yml> [--signed]\n');
  process.exit(2);
}

const problems = updateConfigProblems(readFileSync(file, 'utf8'), {
  signed: flags.includes('--signed'),
});
for (const problem of problems) {
  process.stdout.write(`::error title=Update settings::${file}: ${problem}\n`);
}
if (problems.length === 0) {
  process.stdout.write(`${file}: ok\n`);
}
process.exit(problems.length === 0 ? 0 : 1);
