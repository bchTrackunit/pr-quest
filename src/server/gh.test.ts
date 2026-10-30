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

  test("keeps PR Quest's own API keys out of gh's environment", async () => {
    vi.stubEnv('CURSOR_API_KEY', 'cursor-secret');
    vi.stubEnv('LINEAR_API_KEY', 'linear-secret');
    respondWith(null, '{}');

    try {
      await runGh(['api', 'user']);
    } finally {
      vi.unstubAllEnvs();
    }

    const env = (execFileMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
    expect(env).toMatchObject({ PATH: process.env.PATH, GH_PROMPT_DISABLED: '1' });
    expect(env).not.toHaveProperty('CURSOR_API_KEY');
    expect(env).not.toHaveProperty('LINEAR_API_KEY');
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

  test('keeps what gh printed before failing, such as partial GraphQL data', async () => {
    respondWith(exitError(1), '{"data":{"pr0":null}}', 'gh: Could not resolve\n');

    const error = await runGh(['api', 'graphql']).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ stdout: '{"data":{"pr0":null}}' });
  });

  test('reports a missing gh binary clearly', async () => {
    respondWith(exitError('ENOENT'));

    await expect(runGh(['--version'])).rejects.toThrow('gh CLI not found on PATH');
  });
});
