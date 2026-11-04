import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { ownProcessGroup } from './processGroup.ts';

const MODULE = join(import.meta.dirname, 'processGroup.ts');

/** Whether `pid` is gone within 5 seconds. */
async function gone(pid: number): Promise<boolean> {
  for (let waited = 0; waited < 5000; waited += 100) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * Runs Node as the shell runs the sidecar, `detached` making it lead a process group, with a
 * `sleep` in its group; it prints the sleep's pid, stops the rest of its group and exits 0, or 3
 * if it found no group of its own.
 */
function runSidecarLike(detached: boolean) {
  const script = `
    import { spawn } from 'node:child_process';
    import { ownProcessGroup } from ${JSON.stringify(MODULE)};
    const group = ownProcessGroup();
    process.on('SIGTERM', () => {
      if (!group?.signalledItself()) process.exit(4);
    });
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    console.log(sleeper.pid);
    setTimeout(() => {
      group?.stopOthers();
      setTimeout(() => process.exit(group ? 0 : 3), 300);
    }, 300);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    detached,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return new Promise<{ code: number | null; sleeper: number }>((resolve) => {
    child.on('exit', (code) => resolve({ code, sleeper: Number(output.trim()) }));
  });
}

describe.skipIf(process.platform === 'win32')('ownProcessGroup', () => {
  test('stops the rest of a group the process leads, and the process ignores its own SIGTERM', async () => {
    const { code, sleeper } = await runSidecarLike(true);

    expect(code).toBe(0);
    expect(await gone(sleeper)).toBe(true);
  });

  test("finds no group when the process doesn't lead one, so it signals nobody else's", async () => {
    const { code, sleeper } = await runSidecarLike(false);

    expect(code).toBe(3);
    process.kill(sleeper, 'SIGKILL');
  });

  test('sends SIGTERM to the group whose id is the pid, once', () => {
    const kill = vi.fn();
    const group = ownProcessGroup(4317, kill);

    expect(group?.signalledItself()).toBe(false);
    group?.stopOthers();
    group?.stopOthers();

    expect(kill.mock.calls).toEqual([
      [-4317, 0],
      [-4317, 'SIGTERM'],
    ]);
    expect(group?.signalledItself()).toBe(true);
  });
});
