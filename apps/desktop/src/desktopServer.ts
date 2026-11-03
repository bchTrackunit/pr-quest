import {
  type AppConfig,
  type LocalConfig,
  type RunningServer,
  type ServerOverrides,
  startServer,
} from '@pr-quest/server/server';

/**
 * The server config for the desktop app: local mode on `port`. The window loads the UI from the
 * server itself, so the overrides must leave `devUiOrigin` unset.
 */
export function desktopConfig(base: AppConfig, port: number): LocalConfig {
  if (base.mode !== 'local') {
    throw new Error(
      `The desktop app only runs in local mode; remove PR_QUEST_MODE=${base.mode} from the environment or ${base.stateDir}/.env`,
    );
  }
  return { ...base, port };
}

/**
 * Starts the server on the port it had last time, so the window keeps its origin and with it the
 * UI's saved board view, or on any free port when that one is taken or there was none.
 */
export async function startDesktopServer(
  base: AppConfig,
  preferredPort: number | undefined,
  overrides: ServerOverrides,
  start: typeof startServer = startServer,
): Promise<RunningServer> {
  if (preferredPort !== undefined) {
    try {
      return await start(desktopConfig(base, preferredPort), overrides);
    } catch (error) {
      if (!isAddressInUse(error)) {
        throw error;
      }
      overrides.info?.(`Port ${preferredPort} is in use; picking another one`);
    }
  }
  return start(desktopConfig(base, 0), overrides);
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}
