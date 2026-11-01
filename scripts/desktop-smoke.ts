/*
 * Runs a packaged desktop app in smoke-test mode (see src/desktop/smoke.ts) with a throwaway state
 * directory, and exits with its result. Without an argument it runs the build for this machine in
 * release/; pass the path of another executable, such as one inside a mounted dmg, to check that.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 120_000;

/** Where electron-builder puts the unpacked app for each platform and architecture. */
function defaultExecutable(): string {
  const { platform, arch } = process;
  if (platform === 'darwin') {
    return join(
      'release',
      arch === 'arm64' ? 'mac-arm64' : 'mac',
      'PR Quest.app',
      'Contents',
      'MacOS',
      'PR Quest',
    );
  }
  if (platform === 'win32') {
    return join(
      'release',
      arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked',
      'PR Quest.exe',
    );
  }
  return join('release', arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'pr-quest');
}

const executable = process.argv[2] ?? defaultExecutable();
if (!existsSync(executable)) {
  process.stderr.write(
    `No packaged app at ${executable}; run \`just desktop-package --dir\` first.\n`,
  );
  process.exit(1);
}

const stateDir = mkdtempSync(join(tmpdir(), 'pr-quest-smoke-state-'));
const child = spawn(executable, [], {
  stdio: 'inherit',
  env: {
    ...process.env,
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
