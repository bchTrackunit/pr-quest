import type { AppConfig } from './config.ts';
import type { RouteHandlers } from './router.ts';

/** Route implementations. Any route in `API_ROUTES` left out here responds 501. */
export function createHandlers(config: AppConfig): RouteHandlers {
  return {
    health: () => ({
      ok: true,
      config: {
        linearApiKey: config.linearApiKey !== undefined,
        cursorApiKey: config.cursorApiKey !== undefined,
      },
    }),
  };
}
