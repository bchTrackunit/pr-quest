import type { MenuItemConstructorOptions } from 'electron';

export interface MenuOptions {
  platform: NodeJS.Platform;
  appName: string;
  openHelp: () => void;
}

/**
 * A minimal menu from Electron's standard roles. The Edit menu matters even though it looks
 * optional: without it, copy and paste shortcuts don't work on macOS.
 */
export function menuTemplate(options: MenuOptions): Array<MenuItemConstructorOptions> {
  const help: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [{ label: `${options.appName} Help`, click: options.openHelp }],
  };
  const standard: Array<MenuItemConstructorOptions> = [
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    help,
  ];
  if (options.platform === 'darwin') {
    return [
      {
        label: options.appName,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      ...standard,
    ];
  }
  return [{ role: 'fileMenu' }, ...standard];
}
