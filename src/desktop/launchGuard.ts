/** Chromium switches that open the window to any program that connects, with the player's session. */
const DEBUGGING_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe'];

/**
 * The debugging switch a packaged app was started with, which it should refuse, or `undefined`.
 * The fuses already ignore Node's `--inspect`; these are Chromium's own.
 */
export function forbiddenSwitch(options: {
  isPackaged: boolean;
  hasSwitch: (name: string) => boolean;
}): string | undefined {
  return options.isPackaged ? DEBUGGING_SWITCHES.find(options.hasSwitch) : undefined;
}
