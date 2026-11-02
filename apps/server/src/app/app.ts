import type { SDKModel } from '@cursor/sdk';

import { createAccountHandlers } from './accountHandlers.ts';
import { ApiKeys, ModelCatalog, SettingsStore } from '../features/settings/index.ts';
import { ClaudeReviewer, type CreateMessage, ReviewRunService } from '../features/reviews/index.ts';
import type { AppConfig } from '../platform/config.ts';
import { DeviceFlow, GitHubTokenProvider } from '../features/auth/index.ts';
import { EventHub } from '../platform/events.ts';
import { GameService, StateStore } from '../features/game/index.ts';
import {
  GitHubClient,
  LinearReviewClient,
  QuestCache,
  QuestService,
} from '../features/quests/index.ts';
import {
  GitHubApi,
  GitHubApiError,
  NotSignedInError,
  type FetchLike,
} from '../platform/githubApi.ts';
import { createHandlers, type AppServices } from './handlers.ts';
import type { RouteName } from '@pr-quest/contract/api';
import { ApiError, type EventsHandler, type RouteHandlers } from '../platform/router.ts';
import { SecretStore } from '../platform/secrets.ts';
import { SessionManager, type SessionContext, type SessionServices } from './sessions.ts';
import { migrateLegacyState, userStateDir } from './userState.ts';

/** One player's game, opened from `users/<login>/` when their token is first seen. */
interface UserServices extends SessionServices, AppServices {}

function required<THandler>(handler: THandler | undefined, name: RouteName): THandler {
  if (handler === undefined) {
    throw new ApiError(501, 'notImplemented', `Route "${name}" is not implemented yet`);
  }
  return handler;
}

export interface AppOptions {
  config: AppConfig;
  /** `gh auth token`, the fallback when the player hasn't signed in through PR Quest. */
  ghToken: () => Promise<string | undefined>;
  /** For GitHub, the device flow and Anthropic's model list. */
  fetch?: FetchLike;
  createMessage?: CreateMessage;
  listCursorModels?: (apiKey: string) => Promise<Array<SDKModel>>;
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface App {
  handlers: RouteHandlers;
  /** Opens the current token owner's game so polling starts without waiting for the UI. */
  warmUp: () => Promise<void>;
  close: () => void;
}

/**
 * Wires the server: settings, keys and sign-in are shared, while each GitHub user gets their own
 * game, review runs and quest cache. Game routes act on whoever owns the current token.
 */
export async function createApp(options: AppOptions): Promise<App> {
  const { config, info, warn } = options;
  const secrets = await SecretStore.open(config.stateDir, { onWarning: warn });
  const settings = await SettingsStore.open(config.stateDir, { onWarning: warn });
  const apiKeys = new ApiKeys({
    env: {
      cursor: config.cursorApiKey,
      anthropic: config.anthropicApiKey,
      linear: config.linearApiKey,
    },
    secrets,
  });
  const tokens = new GitHubTokenProvider({
    oauthToken: async () => secrets.get('github'),
    ghToken: options.ghToken,
  });
  const fetchViewer = (token: string) =>
    new GitHubClient(
      new GitHubApi({ token: async () => token, fetch: options.fetch }),
    ).fetchViewer();
  const linear = new LinearReviewClient({ apiKey: () => apiKeys.get('linear'), onWarning: warn });
  const claude = new ClaudeReviewer({
    apiKey: () => apiKeys.get('anthropic'),
    createMessage: options.createMessage,
    log: info,
  });
  /**
   * One store per player for the life of the process: reopening their game after a sign-in change
   * must not load a second copy that a run still finishing in the old session would overwrite.
   */
  const stores = new Map<string, Promise<StateStore>>();
  const openStore = async (login: string, dir: string): Promise<StateStore> => {
    const { migrated } = await migrateLegacyState(config.stateDir, login, { onWarning: warn });
    if (migrated.length > 0) {
      info(
        `Moved ${migrated.join(' and ')} into ${login}'s folder; the originals are kept as .bak files`,
      );
    }
    return StateStore.open(dir, { onWarning: warn });
  };

  const openUser = async ({ login, token }: SessionContext): Promise<UserServices> => {
    const github = new GitHubClient(
      new GitHubApi({
        token,
        fetch: options.fetch,
        onUnauthorized: (rejected) => sessions.rejected(rejected),
      }),
      { onWarning: warn },
    );
    const dir = userStateDir(config.stateDir, login);
    let opening = stores.get(login);
    const firstOpen = opening === undefined;
    if (!opening) {
      opening = openStore(login, dir);
      stores.set(login, opening);
      opening.catch(() => stores.delete(login));
    }
    const store = await opening;
    const events = new EventHub();
    const game = new GameService(store, events, { login });
    const runs = new ReviewRunService({
      store,
      events,
      game,
      cursorApiKey: () => apiKeys.get('cursor'),
      settings: () => settings.get(),
      claude: claude.forGitHub(github),
      log: info,
    });
    const quests = new QuestService({
      github,
      linear,
      events,
      game,
      activeRunIdFor: (questId) => runs.activeRunIdFor(questId),
      log: warn,
      cache: new QuestCache(dir, { onWarning: warn }),
    });
    await quests.restore();
    if (firstOpen) {
      // A reopened game's active runs are still followed by the session that started them.
      await runs.resumeInterrupted();
    }
    const stopPolling = quests.startPolling();
    return {
      login,
      quests,
      runs,
      game,
      github,
      events,
      stop: () => {
        stopPolling();
        events.close();
      },
    };
  };

  const sessions = new SessionManager<UserServices>({
    tokens,
    fetchViewer,
    create: openUser,
    log: info,
  });

  const deviceFlow = new DeviceFlow({
    clientId: config.githubClientId,
    onToken: async (token, { isCurrent }) => {
      await fetchViewer(token);
      if (!isCurrent()) {
        return;
      }
      await secrets.set('github', token);
      sessions.reset();
    },
    log: warn,
    fetch: options.fetch,
  });

  const accountHandlers = createAccountHandlers({
    apiKeys,
    settings,
    models: new ModelCatalog({
      apiKey: (name) => apiKeys.get(name),
      listCursorModels: options.listCursorModels,
      fetch: options.fetch,
    }),
    deviceFlow,
    auth: {
      clientIdConfigured: !!config.githubClientId,
      current: async () => {
        try {
          const session = await sessions.current();
          return session ? { account: session.account } : {};
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
      signOut: async () => {
        const signedOut = sessions.peek()?.account;
        deviceFlow.cancel();
        await secrets.delete('github');
        sessions.reset();
        return signedOut?.tokenSource === 'oauth' ? { signedOutLogin: signedOut.login } : {};
      },
    },
  });

  const gameHandlers = new WeakMap<UserServices, RouteHandlers>();
  const user = async (): Promise<RouteHandlers> => {
    let session;
    try {
      session = await sessions.require();
    } catch (error) {
      if (error instanceof NotSignedInError) {
        throw new ApiError(401, 'notSignedIn', error.message);
      }
      if (error instanceof GitHubApiError) {
        throw new ApiError(
          502,
          'upstreamFailed',
          `GitHub couldn't confirm who is signed in: ${error.message}`,
        );
      }
      throw error;
    }
    let handlers = gameHandlers.get(session.services);
    if (!handlers) {
      handlers = createHandlers(config, session.services);
      gameHandlers.set(session.services, handlers);
    }
    return handlers;
  };

  const userEvents: EventsHandler = (context) => {
    user().then(
      (handlers) => handlers.events?.(context),
      (error: unknown) => {
        const status = error instanceof ApiError ? error.status : 500;
        context.res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
        context.res.end(error instanceof ApiError ? error.message : 'Internal server error');
      },
    );
  };

  return {
    handlers: {
      ...accountHandlers,
      health: () => ({
        ok: true,
        config: {
          linearApiKey: apiKeys.status('linear').set,
          cursorApiKey: apiKeys.status('cursor').set,
          anthropicApiKey: apiKeys.status('anthropic').set,
        },
      }),
      listQuests: async (context) => required((await user()).listQuests, 'listQuests')(context),
      startReview: async (context) => required((await user()).startReview, 'startReview')(context),
      approveQuest: async (context) =>
        required((await user()).approveQuest, 'approveQuest')(context),
      listRuns: async (context) => required((await user()).listRuns, 'listRuns')(context),
      getRun: async (context) => required((await user()).getRun, 'getRun')(context),
      postRun: async (context) => required((await user()).postRun, 'postRun')(context),
      decideFindings: async (context) =>
        required((await user()).decideFindings, 'decideFindings')(context),
      discardRun: async (context) => required((await user()).discardRun, 'discardRun')(context),
      getPlayer: async (context) => required((await user()).getPlayer, 'getPlayer')(context),
      listAchievements: async (context) =>
        required((await user()).listAchievements, 'listAchievements')(context),
      events: userEvents,
    },
    warmUp: async () => {
      try {
        await sessions.current();
      } catch (error) {
        warn(
          `Could not open the game yet: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    close: () => {
      deviceFlow.cancel();
      sessions.close();
    },
  };
}
