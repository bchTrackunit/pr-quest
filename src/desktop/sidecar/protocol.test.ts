import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import {
  BOOTSTRAP_PREFIX,
  bootstrapLine,
  FATAL_PREFIX,
  exitAfterPrinting,
  fatalLine,
  NOTICE_PREFIX,
  noticeLine,
  parseCommand,
  parseLaunch,
  READY_PREFIX,
  readyLine,
  takeStdoutForProtocol,
} from './protocol.ts';

const launch = {
  requestSecret: randomBytes(32).toString('base64url'),
  bootstrapCode: randomBytes(32).toString('base64url'),
  dataKey: randomBytes(32).toString('base64'),
  preferencesFile: '/tmp/desktop.json',
  showNotices: true,
};

describe('parseLaunch', () => {
  test('reads the launch message, with or without a data key', () => {
    expect(parseLaunch(JSON.stringify(launch))).toEqual(launch);
    expect(parseLaunch(JSON.stringify({ ...launch, dataKey: null })).dataKey).toBeNull();
  });

  test('names the bad fields without repeating the secrets', () => {
    const bad = { ...launch, requestSecret: 'short secret', dataKey: 'AAAA' };

    const read = () => parseLaunch(JSON.stringify(bad));

    expect(read).toThrow(/requestSecret, dataKey/);
    expect(read).not.toThrow(/short secret/);
    expect(read).not.toThrow(new RegExp(launch.bootstrapCode));
  });

  test('refuses a line that is not JSON', () => {
    expect(() => parseLaunch('not json')).toThrow(/invalid/);
  });
});

describe('parseCommand', () => {
  test('knows the smoke test command', () => {
    expect(parseCommand('{"command":"smoke"}')).toEqual({ command: 'smoke' });
    expect(parseCommand('{"command":"rebootstrap"}')).toEqual({ command: 'rebootstrap' });
    expect(parseCommand('{"command":"exit"}')).toBeUndefined();
  });

  test('reads the button the player chose in a notice, and only a known one', () => {
    expect(parseCommand('{"command":"notice","action":"retry"}')).toEqual({
      command: 'notice',
      action: 'retry',
    });
    expect(parseCommand('{"command":"notice","action":"format-disk"}')).toBeUndefined();
    expect(parseCommand('{"command":"notice"}')).toBeUndefined();
  });
});

test('noticeLine asks the shell to show a notice, as one prefixed JSON line', () => {
  const notice = {
    message: 'Saved keys',
    detail: 'Line one\nline two',
    buttons: [{ label: 'Continue', action: 'continue' as const }],
  };

  const line = noticeLine(notice);

  expect(line.startsWith(NOTICE_PREFIX)).toBe(true);
  expect(line).not.toContain('\n');
  expect(JSON.parse(line.slice(NOTICE_PREFIX.length))).toEqual(notice);
});

test('fatalLine says why the server could not start, on one line', () => {
  expect(fatalLine('Port\nin use')).toBe(`${FATAL_PREFIX}{"message":"Port\\nin use"}`);
});

test('bootstrapLine hands the shell a new start-up code, as one prefixed JSON line', () => {
  expect(bootstrapLine('c'.repeat(43))).toBe(`${BOOTSTRAP_PREFIX}{"code":"${'c'.repeat(43)}"}`);
});

test('exitAfterPrinting exits only once the line is written, so the shell reads why', () => {
  let written: (() => void) | undefined;
  const stdout = {
    write: vi.fn((_text: string, done: () => void) => {
      written = done;
      return false;
    }),
  };
  const exit = vi.fn();

  exitAfterPrinting(fatalLine('boom'), 1, stdout, exit);

  expect(stdout.write).toHaveBeenCalledWith(`${fatalLine('boom')}\n`, expect.any(Function));
  expect(exit).not.toHaveBeenCalled();
  written?.();
  expect(exit).toHaveBeenCalledWith(1);
});

test('takeStdoutForProtocol leaves stdout to protocol lines and sends other writes to stderr', () => {
  const write = vi.fn((_text: string, ..._rest: Array<unknown>) => true);
  const stdout = { write };
  const stderr = { write: vi.fn((_text: string, ..._rest: Array<unknown>) => true) };
  const done = (): void => undefined;

  const protocol = takeStdoutForProtocol(stdout, stderr);
  stdout.write('a dependency\n');
  protocol.write('PRQUEST_READY {}\n', done);

  expect(stderr.write.mock.calls.map(([text]) => text)).toEqual(['a dependency\n']);
  expect(write.mock.calls).toEqual([['PRQUEST_READY {}\n', done]]);
});

test("takeStdoutForProtocol keeps all of console's output off a real stdout", () => {
  const script = `
    import { takeStdoutForProtocol } from ${JSON.stringify(join(import.meta.dirname, 'protocol.ts'))};
    const protocol = takeStdoutForProtocol();
    console.log('log'); console.info('info'); console.debug('debug'); console.dir({ dir: 1 });
    console.table([{ table: 1 }]); console.count(); console.group('group'); console.groupEnd();
    console.time('time'); console.timeLog('time'); console.timeEnd('time');
    process.stdout.write('direct\\n');
    protocol.write('PROTOCOL\\n');
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });

  expect(run.status).toBe(0);
  expect(run.stdout).toBe('PROTOCOL\n');
  for (const shown of [
    'log',
    'info',
    'debug',
    'dir: 1',
    'table',
    'default: 1',
    'group',
    'time',
    'direct',
  ]) {
    expect(run.stderr).toContain(shown);
  }
});

test('readyLine is one prefixed JSON line', () => {
  expect(readyLine({ port: 4317, storage: 'keychain' })).toBe(
    `${READY_PREFIX}{"port":4317,"storage":"keychain"}`,
  );
});
