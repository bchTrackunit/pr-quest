/*
 * Runs a packaged desktop app in smoke-test mode (see apps/desktop/src-tauri/src/smoke.rs and
 * apps/desktop/src/smoke.ts) with a throwaway state directory, and exits with its result.
 *
 *   node apps/desktop/scripts/desktop-smoke.ts [artifact] [--target <triple>] [--headless] [--no-keychain]
 *
 * The artifact is a .app, .dmg, .AppImage, .deb, NSIS -setup.exe or the executable itself; by
 * default the app, AppImage or installer scripts/desktop-package.ts made for the target. A dmg is
 * mounted, a deb unpacked and an installer installed into a temporary folder, then removed.
 *
 * --headless (Linux) runs it under xvfb-run in its own D-Bus session, with a throwaway unlocked
 * gnome-keyring when one is installed; its keyrings and WebKit's data go in the state directory.
 * --no-keychain passes the keychain checks when the machine has none, as the app then keeps keys
 * in memory.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  artifactKind,
  type ArtifactKind,
  debBinaries,
  defaultArtifact,
  nsisSilent,
  sidecarBinaryProblem,
} from './desktop/artifacts.ts';
import { bundleDir as bundleDirFor } from './desktop/paths.ts';
import { hostTriple, targetFor } from './desktop/targets.ts';

const TIMEOUT_MS = 120_000;
/** An empty password would make gnome-keyring ask for one, which nobody can answer headless. */
const UNLOCK_KEYRING =
  'if command -v gnome-keyring-daemon >/dev/null; then ' +
  'printf smoke | gnome-keyring-daemon --unlock --components=secrets >/dev/null; fi; exec "$@"';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: 'string' },
    headless: { type: 'boolean', default: false },
    'no-keychain': { type: 'boolean', default: false },
  },
});
const target = targetFor(values.target ?? hostTriple(process.platform, process.arch));
const bundleDir = bundleDirFor(target.triple);
const artifact =
  positionals[0] ??
  defaultArtifact(target, bundleDir, (dir) => (existsSync(dir) ? readdirSync(dir) : []));
if (artifact === undefined || !existsSync(artifact)) {
  process.stderr.write(
    `Nothing to check at ${artifact ?? bundleDir}; run \`just desktop-package\` first.\n`,
  );
  process.exit(1);
}

const cleanups: Array<() => void> = [];
let code = 1;
try {
  const path = resolve(artifact);
  const executable = prepare(path);
  const binariesOk = checkBinaries(artifactKind(path), path, executable);
  code = await smoke(executable);
  if (!binariesOk && code === 0) {
    process.stdout.write('[smoke] FAILED\n');
    code = 1;
  }
} finally {
  for (const cleanup of cleanups.reverse()) {
    cleanup();
  }
}
process.exit(code);

/** The executable to run for `path`, after mounting, unpacking or installing it. */
function prepare(path: string): string {
  const kind = artifactKind(path);
  process.stdout.write(`[smoke] info checking the ${kind} ${path}\n`);
  switch (kind) {
    case 'app':
      return join(path, 'Contents', 'MacOS', 'pr-quest');
    case 'dmg': {
      const mount = temporaryDir('pr-quest-dmg-');
      execFileSync('hdiutil', [
        'attach',
        '-nobrowse',
        '-readonly',
        '-noautoopen',
        '-mountpoint',
        mount,
        path,
      ]);
      cleanups.push(() => detach(mount));
      const app = readdirSync(mount).find((name) => name.endsWith('.app'));
      if (app === undefined) {
        throw new Error(`No app in ${path}`);
      }
      return join(mount, app, 'Contents', 'MacOS', 'pr-quest');
    }
    case 'deb': {
      const root = temporaryDir('pr-quest-deb-');
      execFileSync('dpkg-deb', ['-x', path, root]);
      return join(root, 'usr', 'bin', 'pr-quest');
    }
    case 'nsis': {
      const dir = join(temporaryDir('pr-quest-nsis-'), 'PR Quest');
      const [installer, args, options] = nsisSilent(path, '/D=', dir);
      execFileSync(installer, args, { ...options, stdio: 'inherit' });
      cleanups.push(() => {
        const [uninstaller, uninstallArgs, uninstallOptions] = nsisSilent(
          join(dir, 'uninstall.exe'),
          '_?=',
          dir,
        );
        if (existsSync(uninstaller)) {
          execFileSync(uninstaller, uninstallArgs, { ...uninstallOptions, stdio: 'inherit' });
        }
      });
      return join(dir, 'pr-quest.exe');
    }
    case 'appimage':
    case 'executable':
    default:
      return path;
  }
}

/** The sidecar sits next to the shell under its own name, and nothing there is called `node`. */
function checkBinaries(kind: ArtifactKind, path: string, executable: string): boolean {
  const problem = sidecarBinaryProblem(target.os, binariesOf(kind, path, executable));
  process.stdout.write(
    problem === undefined
      ? '[smoke] ok   sidecar-binary: the bundled Node is pr-quest-node, and nothing is called node\n'
      : `[smoke] FAIL sidecar-binary: ${problem}\n`,
  );
  return problem === undefined;
}

function binariesOf(kind: ArtifactKind, path: string, executable: string): Array<string> {
  switch (kind) {
    case 'deb':
      return debBinaries(execFileSync('dpkg-deb', ['-c', path], { encoding: 'utf8' }));
    case 'appimage': {
      const dir = temporaryDir('pr-quest-appimage-bin-');
      execFileSync(path, ['--appimage-extract', 'usr/bin/*'], { cwd: dir, stdio: 'ignore' });
      return readdirSync(join(dir, 'squashfs-root', 'usr', 'bin'));
    }
    case 'app':
    case 'dmg':
    case 'nsis':
    case 'executable':
    default:
      return readdirSync(dirname(executable));
  }
}

/** A real path: Tauri refuses to find its resources through a symlink on macOS, as /tmp is. */
function temporaryDir(prefix: string): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A dmg can stay busy for a moment after the app quits. */
function detach(mount: string): void {
  for (const args of [
    ['detach', mount],
    ['detach', mount],
    ['detach', '-force', mount],
  ]) {
    try {
      execFileSync('hdiutil', args, { stdio: 'ignore' });
      return;
    } catch {
      execFileSync('sleep', ['2']);
    }
  }
  process.stderr.write(`Couldn't detach ${mount}\n`);
}

async function smoke(executable: string): Promise<number> {
  if (!existsSync(executable)) {
    throw new Error(`No executable at ${executable}`);
  }
  // The checks expect made-up keys to be refused, and real ones have no business in a test run.
  const {
    CURSOR_API_KEY: _cursor,
    ANTHROPIC_API_KEY: _anthropic,
    LINEAR_API_KEY: _linear,
    ...env
  } = process.env;
  const stateDir = temporaryDir('pr-quest-smoke-state-');
  const headless = values.headless && process.platform === 'linux';
  const command = headless ? 'xvfb-run' : executable;
  const args = headless
    ? ['-a', 'dbus-run-session', '--', 'sh', '-c', UNLOCK_KEYRING, 'sh', executable]
    : [];
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: {
      ...env,
      PR_QUEST_SMOKE_TEST: '1',
      PR_QUEST_STATE_DIR: stateDir,
      PR_QUEST_DISABLE_UPDATES: '1',
      ...(headless ? { XDG_DATA_HOME: join(stateDir, 'xdg-data') } : {}),
      // No FUSE in containers; the runtime then unpacks the AppImage instead of mounting it.
      APPIMAGE_EXTRACT_AND_RUN: '1',
      ...(values['no-keychain'] ? { PR_QUEST_SMOKE_NO_KEYCHAIN: '1' } : {}),
    },
  });
  const timer = setTimeout(() => {
    process.stderr.write(`The app didn't finish within ${TIMEOUT_MS / 1000} s; stopping it.\n`);
    child.kill('SIGKILL');
  }, TIMEOUT_MS);
  return new Promise((done) => {
    child.on('exit', (exitCode, signal) => {
      clearTimeout(timer);
      done(signal === null ? (exitCode ?? 1) : 1);
    });
  });
}
