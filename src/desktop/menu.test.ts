import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, test, vi } from 'vitest';

import { menuTemplate } from './menu.ts';

const labels = (template: Array<MenuItemConstructorOptions>): Array<string | undefined> =>
  template.map((item) => item.label ?? item.role);

const roles = (item: MenuItemConstructorOptions | undefined): Array<string | undefined> =>
  Array.isArray(item?.submenu) ? item.submenu.map((entry) => entry.role) : [];

const options = { appName: 'PR Quest', openHelp: vi.fn(), devTools: true };

describe('menuTemplate', () => {
  test('macOS gets the app menu first', () => {
    const template = menuTemplate({ ...options, platform: 'darwin' });

    expect(labels(template)).toEqual(['PR Quest', 'editMenu', 'viewMenu', 'windowMenu', 'help']);
    expect(roles(template[0])).toContain('quit');
  });

  test.each(['win32', 'linux'] as const)('%s gets a File menu with Quit', (platform) => {
    const template = menuTemplate({ ...options, platform });

    expect(labels(template)).toEqual(['fileMenu', 'editMenu', 'viewMenu', 'windowMenu', 'help']);
  });

  test('keeps copy and paste working, which need the Edit menu on macOS', () => {
    const edit = menuTemplate({ ...options, platform: 'darwin' }).find(
      (item) => item.role === 'editMenu',
    );

    expect(edit).toBeDefined();
  });

  test('a packaged app has no developer tools in its View menu', () => {
    const template = menuTemplate({ ...options, platform: 'darwin', devTools: false });
    const view = template.find((item) => item.label === 'View');

    expect(labels(template)).not.toContain('viewMenu');
    expect(roles(view)).toEqual(expect.arrayContaining(['reload', 'zoomIn', 'togglefullscreen']));
    expect(roles(view)).not.toContain('toggleDevTools');
  });

  test('Help opens the README', () => {
    const help = menuTemplate({ ...options, platform: 'linux' }).find(
      (item) => item.role === 'help',
    );
    const click = Array.isArray(help?.submenu) ? help.submenu[0]?.click : undefined;
    expect(click).toBeTypeOf('function');

    Reflect.apply(click ?? (() => undefined), undefined, []);

    expect(options.openHelp).toHaveBeenCalled();
  });

  test('Help offers the release page to an install that never updates itself, such as a deb', () => {
    const openDownloads = vi.fn();
    const help = menuTemplate({ ...options, platform: 'linux', openDownloads }).find(
      (item) => item.role === 'help',
    );
    const download = Array.isArray(help?.submenu)
      ? help.submenu.find((item) => item.label === 'Download the Latest Version')
      : undefined;

    Reflect.apply(download?.click ?? (() => undefined), undefined, []);

    expect(openDownloads).toHaveBeenCalled();
  });

  test('Help has no download item where the app updates itself', () => {
    const help = menuTemplate({ ...options, platform: 'linux' }).find(
      (item) => item.role === 'help',
    );

    expect(Array.isArray(help?.submenu) ? help.submenu.map((item) => item.label) : []).toEqual([
      'PR Quest Help',
    ]);
  });
});
