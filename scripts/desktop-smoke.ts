/*
 * Runs a packaged desktop app in smoke-test mode (see src/desktop/smoke.ts) with a throwaway state
 * directory, and exits with its result. Without an argument it runs the macOS app `tauri build`
 * made; pass the path of another executable, such as one inside a mounted dmg, to check that.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 120_000;

/** Where `tauri build` puts the macOS app. */
function defaultExecutable(): string {
  return join(
    'src-tauri',
    'target',
    'release',
    'bundle',
    'macos',
    'PR Quest.app',
    'Contents',
    'MacOS',
    'pr-quest',
  );
}

const executable = process.argv[2] ?? defaultExecutable();
if (!existsSync(executable)) {
  process.stderr.write(
    `No packaged app at ${executable}; run \`just desktop-package --dir\` first.\n`,
  );
  process.exit(1);
}

// The checks expect made-up keys to be refused, and real ones have no business in a test run.
const {
  CURSOR_API_KEY: _cursor,
  ANTHROPIC_API_KEY: _anthropic,
  LINEAR_API_KEY: _linear,
  ...env
} = process.env;
const stateDir = mkdtempSync(join(tmpdir(), 'pr-quest-smoke-state-'));
const child = spawn(executable, [], {
  stdio: 'inherit',
  env: {
    ...env,
    PR_QUEST_SMOKE_TEST: '1',
    PR_QUEST_STATE_DIR: stateDir,
    PR_QUEST_DISABLE_UPDATES: '1',
  },
});
const timer = setTimeout(() => {
  process.stderr.write(`The app didn't finish within ${TIMEOUT_MS / 1000} s; stopping it.\n`);
  child.kill('SIGKILL');
}, TIMEOUT_MS);
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  rmSync(stateDir, { recursive: true, force: true });
  process.exit(signal === null ? (code ?? 1) : 1);
});
