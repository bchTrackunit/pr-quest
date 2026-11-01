import { describe, expect, test, vi } from 'vitest';

import { loadConfig, type RunningServer } from '../app/server/server.ts';
import { trustedRequests } from '../platform/server/router.ts';
import { desktopConfig, startDesktopServer } from './desktopServer.ts';

const base = loadConfig({ env: { PR_QUEST_STATE_DIR: '/tmp/pr-quest-desktop-test' } });

const running = (port: number): RunningServer => ({
  url: `http://127.0.0.1:${port}`,
  port,
  close: () => Promise.resolve(),
});

const inUse = (): Error => Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });

describe('desktopConfig', () => {
  test('listens on loopback and trusts no UI port besides its own', () => {
    const config = desktopConfig(base, 53124);

    expect(config).toMatchObject({ mode: 'local', host: '127.0.0.1', port: 53124 });
    const { allowedOrigins } = trustedRequests(config, 53124);
    expect(allowedOrigins).toContain('http://127.0.0.1:53124');
    expect(allowedOrigins.some((origin) => origin.endsWith(`:${base.uiPort}`))).toBe(false);
  });

  test('refuses hosted mode', () => {
    expect(() => desktopConfig({ ...base, mode: 'hosted' }, 0)).toThrow(/local mode/);
  });
});

describe('startDesktopServer', () => {
  test('starts on the port it used last time, so the window keeps its origin', async () => {
    const start = vi.fn().mockResolvedValue(running(53124));

    await expect(startDesktopServer(base, 53124, {}, start)).resolves.toMatchObject({
      port: 53124,
    });
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ port: 53124 }), {});
  });

  test('takes any free port when the last one is in use', async () => {
    const start = vi.fn().mockRejectedValueOnce(inUse()).mockResolvedValueOnce(running(60001));
    const info = vi.fn();

    await expect(startDesktopServer(base, 53124, { info }, start)).resolves.toMatchObject({
      port: 60001,
    });
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ port: 0 }), { info });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('53124'));
  });

  test('takes any free port the first time', async () => {
    const start = vi.fn().mockResolvedValue(running(60002));

    await startDesktopServer(base, undefined, {}, start);

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ port: 0 }), {});
  });

  test('passes other start errors on', async () => {
    const start = vi.fn().mockRejectedValue(new Error('state dir is not writable'));

    await expect(startDesktopServer(base, 53124, {}, start)).rejects.toThrow(/not writable/);
    expect(start).toHaveBeenCalledOnce();
  });
});
