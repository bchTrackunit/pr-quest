/*
 * macOS only: starts the packaged app with a throwaway state directory, lets it idle, and prints
 * the memory footprint of all its processes, the way Activity Monitor counts it. Then checks that
 * quitting and a crashed shell leave no process behind, that a crashed sidecar is started again,
 * and that one which keeps crashing makes the shell give up.
 *
 *   node scripts/desktop-measure.ts [executable]
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const IDLE_MS = 25_000;
const EXIT_WAIT_MS = 10_000;
const RESTART_WAIT_MS = 15_000;
/** src-tauri/src/main.rs's MAX_RESTARTS. */
const MAX_RESTARTS = 3;
const DEFAULT_EXECUTABLE = join(
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

// AppleScript finds an app by its absolute path; anything else it takes for a name.
const executable = resolve(process.argv[2] ?? DEFAULT_EXECUTABLE);
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
  const child = spawn(executable, [], {
    stdio: 'ignore',
    env: {
      ...env,
      PR_QUEST_STATE_DIR: stateDir,
      PR_QUEST_DISABLE_UPDATES: '1',
      PR_QUEST_SMOKE_TEST: 'idle',
    },
  });
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
  const webKit = all.filter((proc) => isWebKit(proc) && !webKitBefore.has(proc.pid));
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
    `${total.toFixed(1).padStart(8)} MiB  total after ${IDLE_MS / 1000} s idle\n`,
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
    descendants(running.pid, processes()).find((proc) => proc.command.endsWith('/pr-quest-node'));
  const scenario = async (
    name: string,
    check: (running: Running, sidecar: Proc) => Promise<string | undefined>,
    detail: string,
  ): Promise<void> => {
    const running = launch();
    await delay(8000);
    const sidecar = sidecarOf(running);
    const problem =
      sidecar === undefined ? 'no node sidecar under the shell' : await check(running, sidecar);
    process.stdout.write(
      `[lifecycle] ${problem === undefined ? 'ok  ' : 'FAIL'} ${name}: ${problem ?? detail}\n`,
    );
    if (problem !== undefined) {
      process.exitCode = 1;
    }
    for (const proc of [running, ...descendants(running.pid, processes())]) {
      if (alive(proc.pid)) {
        process.kill(proc.pid, 'SIGKILL');
      }
    }
    rmSync(running.stateDir, { recursive: true, force: true });
  };
  /** The sidecar the shell started after `previous` died, once it has. */
  const restarted = async (running: Running, previous: Proc): Promise<Proc | undefined> => {
    for (let waited = 0; waited < RESTART_WAIT_MS; waited += 250) {
      const next = sidecarOf(running);
      if (next !== undefined && next.pid !== previous.pid) {
        return next;
      }
      await delay(250);
    }
    return undefined;
  };

  await scenario(
    'quit',
    async (running, sidecar) => {
      quit();
      return (await exitsWithin([running.pid, sidecar.pid], EXIT_WAIT_MS))
        ? undefined
        : 'something was still running after quitting';
    },
    'quitting the app stopped the shell and the sidecar',
  );
  await scenario(
    'shell-crash',
    async (running, sidecar) => {
      process.kill(running.pid, 'SIGKILL');
      return (await exitsWithin([sidecar.pid], EXIT_WAIT_MS))
        ? undefined
        : 'the sidecar outlived the killed shell';
    },
    'the sidecar stopped itself once the killed shell closed its stdin',
  );
  await scenario(
    'sidecar-crash',
    async (running, sidecar) => {
      process.kill(sidecar.pid, 'SIGKILL');
      if ((await restarted(running, sidecar)) === undefined) {
        return "the shell didn't start a new sidecar";
      }
      return alive(running.pid) ? undefined : 'the shell quit';
    },
    'the shell started a new sidecar and kept running',
  );
  await scenario(
    'sidecar-keeps-crashing',
    async (running, first) => {
      let sidecar: Proc | undefined = first;
      for (let crash = 1; crash <= MAX_RESTARTS; crash += 1) {
        process.kill(sidecar.pid, 'SIGKILL');
        sidecar = await restarted(running, sidecar);
        if (sidecar === undefined) {
          return `the shell didn't restart the sidecar after crash ${crash}`;
        }
      }
      process.kill(sidecar.pid, 'SIGKILL');
      return (await exitsWithin([running.pid], EXIT_WAIT_MS))
        ? undefined
        : `the shell still runs after ${MAX_RESTARTS + 1} crashes`;
    },
    `the shell gave up after restarting the sidecar ${MAX_RESTARTS} times`,
  );
}

await measure();
await lifecycle();
