import type { MenuItemConstructorOptions } from 'electron';

export interface MenuOptions {
  platform: NodeJS.Platform;
  appName: string;
  openHelp: () => void;
  /** Opens the release page; given only to an install that doesn't update itself. */
  openDownloads?: () => void;
  /** Offers Toggle Developer Tools, which only development builds should. */
  devTools: boolean;
}

/** Electron's View menu without Toggle Developer Tools. */
const VIEW_WITHOUT_DEV_TOOLS: MenuItemConstructorOptions = {
  label: 'View',
  submenu: [
    { role: 'reload' },
    { role: 'forceReload' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ],
};

/**
 * A minimal menu from Electron's standard roles. The Edit menu matters even though it looks
 * optional: without it, copy and paste shortcuts don't work on macOS.
 */
export function menuTemplate(options: MenuOptions): Array<MenuItemConstructorOptions> {
  const help: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      { label: `${options.appName} Help`, click: options.openHelp },
      ...(options.openDownloads
        ? [{ label: 'Download the Latest Version', click: options.openDownloads }]
        : []),
    ],
  };
  const standard: Array<MenuItemConstructorOptions> = [
    { role: 'editMenu' },
    options.devTools ? { role: 'viewMenu' } : VIEW_WITHOUT_DEV_TOOLS,
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
