/*
 * Fails when a packaged app's app-update.yml names a channel, whose update files releases don't
 * publish, or another repository than --repo, or, with --signed, no publisher to check an update's
 * signer against; see src/desktop/updateConfig.ts.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { updateConfigProblems } from '../src/desktop/updateConfig.ts';

function parse(): { file: string; signed: boolean; repo: string | undefined } | undefined {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { signed: { type: 'boolean' }, repo: { type: 'string' } },
    });
    const [path] = positionals;
    return positionals.length === 1 && path !== undefined
      ? { file: path, signed: values.signed ?? false, repo: values.repo }
      : undefined;
  } catch {
    return undefined;
  }
}

const args = parse();
if (args === undefined) {
  process.stderr.write(
    'usage: node scripts/check-update-config.ts <app-update.yml> [--repo owner/repo] [--signed]\n',
  );
  process.exit(2);
}
const { file } = args;
const problems = updateConfigProblems(readFileSync(file, 'utf8'), args);
for (const problem of problems) {
  process.stdout.write(`::error title=Update settings::${file}: ${problem}\n`);
}
if (problems.length === 0) {
  process.stdout.write(`${file}: ok\n`);
}
process.exit(problems.length === 0 ? 0 : 1);
