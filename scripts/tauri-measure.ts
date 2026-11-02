/*
 * Spike, macOS only: compares the packaged Electron and Tauri apps. Starts one with a throwaway
 * state directory, lets it idle, and prints the memory footprint of all its processes, the way
 * Activity Monitor counts it. For Tauri it then checks that quitting, a crashed shell and a
 * crashed sidecar each leave no process behind.
 *
 *   node scripts/tauri-measure.ts electron|tauri [executable]
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const IDLE_MS = 25_000;
const EXIT_WAIT_MS = 10_000;
const DEFAULTS = {
  electron: join('release', 'mac-arm64', 'PR Quest.app', 'Contents', 'MacOS', 'PR Quest'),
  tauri: join(
    'src-tauri',
    'target',
    'release',
    'bundle',
    'macos',
    'PR Quest.app',
    'Contents',
    'MacOS',
    'pr-quest',
  ),
};

const kind = process.argv[2];
if (kind !== 'electron' && kind !== 'tauri') {
  throw new Error('Usage: node scripts/tauri-measure.ts electron|tauri [executable]');
}
// AppleScript finds an app by its absolute path; anything else it takes for a name.
const executable = resolve(process.argv[3] ?? DEFAULTS[kind]);
if (!existsSync(executable)) {
  throw new Error(`No packaged app at ${executable}`);
}

interface Proc {
  pid: number;
  ppid: number;
  command: string;
}

function processes(): Array<Proc> {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match !== null)
    .map(([, pid, ppid, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      command: command ?? '',
    }));
}

function descendants(root: number, all: ReadonlyArray<Proc>): Array<Proc> {
  const found: Array<Proc> = [];
  const visit = (pid: number): void => {
    for (const child of all.filter((proc) => proc.ppid === pid)) {
      found.push(child);
      visit(child.pid);
    }
  };
  visit(root);
  return found;
}

/** WebKit runs a Tauri window's content in XPC services whose parent is launchd, not the app. */
const isWebKit = (proc: Proc): boolean => proc.command.includes('com.apple.WebKit.');

function footprintMiB(pid: number): number {
  const text = execFileSync('footprint', ['-f', 'bytes', '-p', String(pid)], { encoding: 'utf8' });
  const bytes = /Footprint:\s+(\d+)\s+B/.exec(text)?.[1];
  return bytes === undefined ? Number.NaN : Number(bytes) / 1024 / 1024;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exitsWithin(pids: ReadonlyArray<number>, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 250) {
    if (pids.every((pid) => !alive(pid))) {
      return true;
    }
    await delay(250);
  }
  return false;
}

interface Running {
  pid: number;
  stateDir: string;
  webKitBefore: Set<number>;
}

function launch(): Running {
  const stateDir = mkdtempSync(join(tmpdir(), 'pr-quest-measure-'));
  const webKitBefore = new Set(
    processes()
      .filter(isWebKit)
      .map((proc) => proc.pid),
  );
  const { CURSOR_API_KEY: _c, ANTHROPIC_API_KEY: _a, LINEAR_API_KEY: _l, ...env } = process.env;
  const child = spawn(
    executable,
    // The Electron build's own smoke test uses a mock keychain too, so nothing prompts.
    kind === 'electron' ? ['--use-mock-keychain', '--password-store=basic'] : [],
    {
      stdio: 'ignore',
      env: {
        ...env,
        PR_QUEST_STATE_DIR: stateDir,
        PR_QUEST_DISABLE_UPDATES: '1',
        ...(kind === 'tauri' ? { PR_QUEST_SMOKE_TEST: 'idle' } : {}),
      },
    },
  );
  if (child.pid === undefined) {
    throw new Error(`Couldn't start ${executable}`);
  }
  // This script decides when the app stops; an app left running mustn't keep it waiting.
  child.unref();
  return { pid: child.pid, stateDir, webKitBefore };
}

function tree({ pid, webKitBefore }: Running): Array<Proc> {
  const all = processes();
  const own = all.find((proc) => proc.pid === pid);
  const children = descendants(pid, all);
  const webKit =
    kind === 'tauri' ? all.filter((proc) => isWebKit(proc) && !webKitBefore.has(proc.pid)) : [];
  return [...(own ? [own] : []), ...children, ...webKit];
}

async function measure(): Promise<void> {
  const running = launch();
  await delay(IDLE_MS);
  const procs = tree(running);
  let total = 0;
  for (const proc of procs) {
    const mib = footprintMiB(proc.pid);
    total += mib;
    process.stdout.write(`${mib.toFixed(1).padStart(8)} MiB  ${proc.pid}  ${proc.command}\n`);
  }
  process.stdout.write(
    `${total.toFixed(1).padStart(8)} MiB  total for ${kind} after ${IDLE_MS / 1000} s idle\n`,
  );
  await stop(running, procs);
}

/** Quits the app as the Dock's Quit does, and kills whatever is left after `EXIT_WAIT_MS`. */
async function stop(running: Running, procs: ReadonlyArray<Proc>): Promise<void> {
  quit();
  const pids = procs.map((proc) => proc.pid);
  if (!(await exitsWithin(pids, EXIT_WAIT_MS))) {
    process.stdout.write(`(still running after quitting: ${pids.filter(alive).join(', ')})\n`);
    for (const pid of pids.filter(alive)) {
      process.kill(pid, 'SIGKILL');
    }
  }
  rmSync(running.stateDir, { recursive: true, force: true });
}

function quit(): void {
  const appBundle = executable.replace(/\/Contents\/MacOS\/[^/]+$/, '');
  execFileSync('osascript', ['-e', `tell application "${appBundle}" to quit`]);
}

async function lifecycle(): Promise<void> {
  const sidecarOf = (running: Running): Proc | undefined =>
    descendants(running.pid, processes()).find((proc) => proc.command.endsWith('/node'));
  const report = (name: string, ok: boolean, detail: string): void => {
    process.stdout.write(`[lifecycle] ${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}\n`);
    process.exitCode = ok ? process.exitCode : 1;
  };
  const scenario = async (
    name: string,
    act: (running: Running, sidecar: Proc) => void,
    gone: (running: Running, sidecar: Proc) => Array<number>,
    detail: string,
  ): Promise<void> => {
    const running = launch();
    await delay(8000);
    const sidecar = sidecarOf(running);
    if (sidecar === undefined) {
      report(name, false, 'no node sidecar under the shell');
    } else {
      act(running, sidecar);
      report(name, await exitsWithin(gone(running, sidecar), EXIT_WAIT_MS), detail);
    }
    for (const pid of [running.pid, ...(sidecar ? [sidecar.pid] : [])]) {
      if (alive(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    }
    rmSync(running.stateDir, { recursive: true, force: true });
  };

  await scenario(
    'quit',
    quit,
    (running, sidecar) => [running.pid, sidecar.pid],
    'quitting the app stopped the shell and the sidecar',
  );
  await scenario(
    'shell-crash',
    (running) => process.kill(running.pid, 'SIGKILL'),
    (_running, sidecar) => [sidecar.pid],
    'the sidecar stopped itself once the killed shell closed its stdin',
  );
  await scenario(
    'sidecar-crash',
    (_running, sidecar) => process.kill(sidecar.pid, 'SIGKILL'),
    (running) => [running.pid],
    'the shell quit when its sidecar died',
  );
}

await measure();
if (kind === 'tauri') {
  await lifecycle();
}
