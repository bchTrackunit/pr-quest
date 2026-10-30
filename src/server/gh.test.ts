import { execFile } from 'node:child_process';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { GhError, runGh } from './gh.ts';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const execFileMock = vi.mocked(execFile);
const stdinEnd = vi.fn();

function respondWith(error: Error | null, stdout = '', stderr = ''): void {
  execFileMock.mockImplementation(((
    _file: string,
    _args: Array<string>,
    _options: unknown,
    callback: ExecCallback,
  ) => {
    queueMicrotask(() => callback(error, stdout, stderr));
    return { stdin: { end: stdinEnd } };
  }) as unknown as typeof execFile);
}

function exitError(code: number | string): Error {
  return Object.assign(new Error('Command failed'), { code });
}

beforeEach(() => {
  execFileMock.mockReset();
  stdinEnd.mockReset();
});

describe('runGh', () => {
  test('runs gh with an argument array and returns stdout', async () => {
    respondWith(null, '{"ok":true}');

    await expect(runGh(['pr', 'view', '1', '-R', 'o/r'])).resolves.toBe('{"ok":true}');

    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', '1', '-R', 'o/r'],
      expect.not.objectContaining({ shell: true }),
      expect.any(Function),
    );
  });

  test('writes input to stdin', async () => {
    respondWith(null, '{}');

    await runGh(['api', '--input', '-'], { input: '{"event":"COMMENT"}' });

    expect(stdinEnd).toHaveBeenCalledWith('{"event":"COMMENT"}');
  });

  test('rejects with the HTTP status gh reported', async () => {
    respondWith(
      exitError(1),
      '{"message":"Validation Failed"}',
      'gh: Validation Failed (HTTP 422)\n',
    );

    const error = await runGh(['api', 'x']).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GhError);
    expect(error).toMatchObject({ httpStatus: 422, message: 'gh: Validation Failed (HTTP 422)' });
  });

  test('reports a missing gh binary clearly', async () => {
    respondWith(exitError('ENOENT'));

    await expect(runGh(['--version'])).rejects.toThrow('gh CLI not found on PATH');
  });
});
