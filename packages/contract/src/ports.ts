/** The server acts as the player, so it only ever listens on loopback. */
export const SERVER_HOST = '127.0.0.1';
export const DEFAULT_SERVER_PORT = 4317;
export const DEFAULT_UI_PORT = 4318;

export interface Ports {
  port: number;
  uiPort: number;
}

/**
 * Reads `PR_QUEST_PORT` and `PR_QUEST_UI_PORT` through `read`. The server and the Vite dev server
 * both call this, because the dev server proxies `/api` to the server's port and the server only
 * accepts requests from the UI's origin.
 */
export function readPorts(read: (name: string) => string | undefined): Ports {
  return {
    port: parsePort(read('PR_QUEST_PORT'), DEFAULT_SERVER_PORT, 'PR_QUEST_PORT'),
    uiPort: parsePort(read('PR_QUEST_UI_PORT'), DEFAULT_UI_PORT, 'PR_QUEST_UI_PORT'),
  };
}

function parsePort(raw: string | undefined, fallback: number, name: string): number {
  const value = raw?.trim();
  if (!value) {
    return fallback;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535, got "${value}"`);
  }
  return port;
}
