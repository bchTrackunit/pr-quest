import { execFile } from 'node:child_process';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ghSearchPath, readGhToken } from './ghToken.ts';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const execFileMock = vi.mocked(execFile);

function respondWith(error: Error | null, stdout = ''): void {
  execFileMock.mockImplementation(((
    _file: string,
    _args: Array<string>,
    _options: unknown,
    callback: ExecCallback,
  ) => {
    queueMicrotask(() => callback(error, stdout, ''));
    return {};
  }) as unknown as typeof execFile);
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe('readGhToken', () => {
  test('runs `gh auth token` without a shell and returns the trimmed token', async () => {
    respondWith(null, 'gho_fromgh\n');

    await expect(readGhToken()).resolves.toBe('gho_fromgh');
    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['auth', 'token'],
      expect.not.objectContaining({ shell: true }),
      expect.any(Function),
    );
  });

  test("keeps PR Quest's own secrets out of gh's environment", async () => {
    vi.stubEnv('CURSOR_API_KEY', 'cursor-secret');
    vi.stubEnv('LINEAR_API_KEY', 'linear-secret');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-secret');
    respondWith(null, 'gho_x');

    try {
      await readGhToken();
    } finally {
      vi.unstubAllEnvs();
    }

    const env = (execFileMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
    expect(env).toMatchObject({
      PATH: ghSearchPath(process.env.PATH, process.platform),
      GH_PROMPT_DISABLED: '1',
    });
    expect(env).not.toHaveProperty('CURSOR_API_KEY');
    expect(env).not.toHaveProperty('LINEAR_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  test.skipIf(process.platform === 'win32')(
    "also looks for gh where Homebrew installs it, which an app opened from the Dock doesn't have on its PATH",
    async () => {
      vi.stubEnv('PATH', '/usr/bin:/bin');
      respondWith(null, 'gho_x');

      try {
        await readGhToken();
      } finally {
        vi.unstubAllEnvs();
      }

      expect(execFileMock).toHaveBeenCalledWith(
        'gh',
        ['auth', 'token'],
        expect.objectContaining({
          env: expect.objectContaining({ PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' }),
        }),
        expect.any(Function),
      );
    },
  );
});

describe('ghSearchPath', () => {
  test('appends the usual install folders after the inherited PATH', () => {
    expect(ghSearchPath('/usr/bin:/bin', 'darwin')).toBe(
      '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
    );
  });

  test('keeps the PATH order and adds no folder twice', () => {
    expect(ghSearchPath('/usr/local/bin:/usr/bin', 'linux')).toBe(
      '/usr/local/bin:/usr/bin:/opt/homebrew/bin',
    );
  });

  test('works without an inherited PATH', () => {
    expect(ghSearchPath(undefined, 'darwin')).toBe('/opt/homebrew/bin:/usr/local/bin');
  });

  test('leaves Windows alone', () => {
    expect(ghSearchPath('C:\\Windows\\System32', 'win32')).toBe('C:\\Windows\\System32');
  });

  test.each([
    ['gh is not installed', Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })],
    ['gh is not logged in', Object.assign(new Error('Command failed'), { code: 1 })],
  ])('resolves undefined when %s', async (_label, error) => {
    respondWith(error);

    await expect(readGhToken()).resolves.toBeUndefined();
  });

  test('resolves undefined for empty output', async () => {
    respondWith(null, '  \n');

    await expect(readGhToken()).resolves.toBeUndefined();
  });
});
