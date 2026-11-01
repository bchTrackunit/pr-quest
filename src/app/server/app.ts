import type { IncomingMessage } from 'node:http';
import type { SDKModel } from '@cursor/sdk';

import {
  type AuthServices,
  createAuthHandlers,
  createSettingsHandlers,
} from './accountHandlers.ts';
import { ApiKeys, ModelCatalog, type SettingsStore } from '../../features/settings/server/index.ts';
import {
  ClaudeReviewer,
  type CreateMessage,
  ReviewRunService,
} from '../../features/reviews/server/index.ts';
import { type AppConfig, assertSafeConfig } from '../../platform/server/config.ts';
import { DeviceFlow } from '../../features/auth/server/index.ts';
import { EventHub } from '../../platform/server/events.ts';
import { GameService, type StateStore } from '../../features/game/server/index.ts';
import {
  GitHubClient,
  LinearReviewClient,
  QuestService,
} from '../../features/quests/server/index.ts';
import {
  GitHubApi,
  GitHubApiError,
  NotSignedInError,
  type FetchLike,
} from '../../platform/server/githubApi.ts';
import { createHandlers, type AppServices } from './handlers.ts';
import type { ApiKeyName, RouteName } from '../../shared/api.ts';
import {
  ApiError,
  type EventsHandler,
  type RouteHandler,
  type RouteHandlers,
} from '../../platform/server/router.ts';
import type { SecretStore } from '../../platform/server/secrets.ts';
import {
  type IdentityContext,
  type IdentityFactory,
  type IdentityResolver,
  LocalIdentityResolver,
} from './identity.ts';
import type { SessionContext, SessionServices } from './sessions.ts';
import {
  type AppStorage,
  createFileStorage,
  MACHINE_SCOPE,
  scopeKey,
  type StorageScope,
} from './storage.ts';

/** One player's game, opened when their sign-in is first seen. */
export interface UserServices extends SessionServices, AppServices {}

type JsonRouteName = Exclude<RouteName, 'events'>;
type JsonRouteHandlers = { [TName in JsonRouteName]?: RouteHandler<TName> };

function required<THandler>(handler: THandler | undefined, name: RouteName): THandler {
  if (handler === undefined) {
    throw new ApiError(501, 'notImplemented', `Route "${name}" is not implemented yet`);
  }
  return handler;
}

/** Answers `name` with the handler that `handlersFor` picks for the request. */
function perRequest<TName extends JsonRouteName>(
  name: TName,
  handlersFor: (req: IncomingMessage) => Promise<RouteHandlers>,
): RouteHandler<TName> {
  return async (context) => {
    const handlers: JsonRouteHandlers = await handlersFor(context.req);
    return required<RouteHandler<TName>>(handlers[name], name)(context);
  };
}

/** Sign-in failures as API errors: 401 when nobody is signed in, 502 when GitHub can't say. */
function signInFailure(error: unknown): never {
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

export interface AppOptions {
  config: AppConfig;
  /** `gh auth token`, the local fallback when the player hasn't signed in through PR Quest. */
  ghToken?: () => Promise<string | undefined>;
  /** Where everything is saved. Defaults to the JSON files in `config.stateDir`. */
  storage?: AppStorage;
  /**
   * Works out who each request acts as. Defaults to local mode's one player per machine. An
   * injected resolver turns off the device flow and the gh fallback, which only work locally.
   */
  identity?: IdentityFactory<UserServices>;
  /** For GitHub, the device flow and Anthropic's model list. */
  fetch?: FetchLike;
  createMessage?: CreateMessage;
  listCursorModels?: (apiKey: string) => Promise<Array<SDKModel>>;
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface App {
  handlers: RouteHandlers;
  /** Opens the current player's game so polling starts without waiting for the UI. */
  warmUp: () => Promise<void>;
  close: () => void;
}

/** What follows one storage scope's keys and settings; in local mode, the machine's. */
interface ScopedServices {
  secrets: SecretStore;
  apiKeys: ApiKeys;
  settings: SettingsStore;
  models: ModelCatalog;
  linear: LinearReviewClient;
  claude: ClaudeReviewer;
}

/**
 * Wires the server. Keys and settings belong to a storage scope, which is the whole machine in
 * local mode, while each GitHub user gets their own game, review runs and quest cache. Every
 * request acts on whoever the identity resolver says sent it.
 */
export async function createApp(options: AppOptions): Promise<App> {
  const { config, info, warn } = options;
  assertSafeConfig(config);
  const storage = options.storage ?? createFileStorage(config.stateDir, { info, warn });
  const envKeys: Partial<Record<ApiKeyName, string>> = {
    cursor: config.cursorApiKey,
    anthropic: config.anthropicApiKey,
    linear: config.linearApiKey,
  };

  const openScope = async (scope: StorageScope): Promise<ScopedServices> => {
    const [secrets, settings] = await Promise.all([
      storage.secrets(scope),
      storage.settings(scope),
    ]);
    // Keys from the environment are the server owner's, so a signed-in user's scope never sees them.
    const apiKeys = new ApiKeys({ env: scope.kind === 'machine' ? envKeys : {}, secrets });
    return {
      secrets,
      apiKeys,
      settings,
      models: new ModelCatalog({
        apiKey: (name) => apiKeys.get(name),
        listCursorModels: options.listCursorModels,
        fetch: options.fetch,
      }),
      linear: new LinearReviewClient({ apiKey: () => apiKeys.get('linear'), onWarning: warn }),
      claude: new ClaudeReviewer({
        apiKey: () => apiKeys.get('anthropic'),
        createMessage: options.createMessage,
        log: info,
      }),
    };
  };
  const scopes = new Map<string, Promise<ScopedServices>>();
  const servicesFor = (scope: StorageScope): Promise<ScopedServices> => {
    const key = scopeKey(scope);
    let opening = scopes.get(key);
    if (!opening) {
      opening = openScope(scope);
      scopes.set(key, opening);
      opening.catch(() => scopes.delete(key));
    }
    return opening;
  };
  // Opened now, so a secrets or settings file this build can't read stops the server at startup.
  const machine = await servicesFor(MACHINE_SCOPE);

  const fetchViewer = (token: string) =>
    new GitHubClient(
      new GitHubApi({ token: async () => token, fetch: options.fetch }),
    ).fetchViewer();
  /**
   * One store per player for the life of the process: reopening their game after a sign-in change
   * must not load a second copy that a run still finishing in the old session would overwrite.
   */
  const stores = new Map<string, Promise<StateStore>>();

  const openUser = async ({ login, token }: SessionContext): Promise<UserServices> => {
    const github = new GitHubClient(
      new GitHubApi({
        token,
        fetch: options.fetch,
        onUnauthorized: (rejected) => identity.rejected(rejected),
      }),
      { onWarning: warn },
    );
    let opening = stores.get(login);
    const firstOpen = opening === undefined;
    if (!opening) {
      opening = storage.gameState(login);
      stores.set(login, opening);
      opening.catch(() => stores.delete(login));
    }
    const [store, scoped, cache] = await Promise.all([
      opening,
      servicesFor(identity.scopeFor(login)),
      storage.questCache(login),
    ]);
    const events = new EventHub();
    const game = new GameService(store, events, { login });
    const runs = new ReviewRunService({
      store,
      events,
      game,
      cursorApiKey: () => scoped.apiKeys.get('cursor'),
      settings: () => scoped.settings.get(),
      claude: scoped.claude.forGitHub(github),
      log: info,
    });
    const quests = new QuestService({
      github,
      linear: scoped.linear,
      events,
      game,
      activeRunIdFor: (questId) => runs.activeRunIdFor(questId),
      log: warn,
      cache,
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

  const context: IdentityContext<UserServices> = { openUser, fetchViewer, storage, log: info };
  let identity: IdentityResolver<UserServices>;
  let local: LocalIdentityResolver<UserServices> | undefined;
  if (options.identity) {
    identity = await options.identity(context);
  } else {
    local = new LocalIdentityResolver({
      ...context,
      secrets: machine.secrets,
      ghToken: options.ghToken ?? (async () => undefined),
    });
    identity = local;
  }

  const deviceFlow = new DeviceFlow({
    clientId: local ? config.githubClientId : undefined,
    onToken: async (token, { isCurrent }) => {
      await fetchViewer(token);
      if (!isCurrent()) {
        return;
      }
      await local?.signIn(token);
    },
    log: warn,
    fetch: options.fetch,
  });

  const auth = (req: IncomingMessage): AuthServices['auth'] => ({
    clientIdConfigured: local !== undefined && !!config.githubClientId,
    current: async () => {
      try {
        const session = await identity.resolve(req);
        return session ? { account: session.account } : {};
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    signOut: async () => {
      deviceFlow.cancel();
      const signedOut = await identity.signOut(req);
      return signedOut?.tokenSource === 'oauth' ? { signedOutLogin: signedOut.login } : {};
    },
  });
  const authFor = async (req: IncomingMessage): Promise<RouteHandlers> =>
    createAuthHandlers({ deviceFlow, auth: auth(req) });

  const settingsHandlers = new WeakMap<ScopedServices, RouteHandlers>();
  const settingsFor = async (req: IncomingMessage): Promise<RouteHandlers> => {
    const scope = await identity.scope(req).catch(signInFailure);
    const scoped = await servicesFor(scope);
    let handlers = settingsHandlers.get(scoped);
    if (!handlers) {
      handlers = createSettingsHandlers(scoped);
      settingsHandlers.set(scoped, handlers);
    }
    return handlers;
  };

  const gameHandlers = new WeakMap<UserServices, RouteHandlers>();
  const user = async (req: IncomingMessage): Promise<RouteHandlers> => {
    const session = await identity.resolve(req).catch(signInFailure);
    if (!session) {
      signInFailure(new NotSignedInError());
    }
    let handlers = gameHandlers.get(session.services);
    if (!handlers) {
      handlers = createHandlers(config, session.services);
      gameHandlers.set(session.services, handlers);
    }
    return handlers;
  };

  const userEvents: EventsHandler = (eventsContext) => {
    user(eventsContext.req).then(
      (handlers) => handlers.events?.(eventsContext),
      (error: unknown) => {
        const status = error instanceof ApiError ? error.status : 500;
        eventsContext.res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
        eventsContext.res.end(error instanceof ApiError ? error.message : 'Internal server error');
      },
    );
  };

  return {
    handlers: {
      health: () => ({
        ok: true,
        config: {
          linearApiKey: machine.apiKeys.status('linear').set,
          cursorApiKey: machine.apiKeys.status('cursor').set,
          anthropicApiKey: machine.apiKeys.status('anthropic').set,
        },
      }),
      authStatus: perRequest('authStatus', authFor),
      startDeviceFlow: perRequest('startDeviceFlow', authFor),
      getDeviceFlow: perRequest('getDeviceFlow', authFor),
      cancelDeviceFlow: perRequest('cancelDeviceFlow', authFor),
      signOut: perRequest('signOut', authFor),
      getSettings: perRequest('getSettings', settingsFor),
      updateSettings: perRequest('updateSettings', settingsFor),
      setApiKey: perRequest('setApiKey', settingsFor),
      removeApiKey: perRequest('removeApiKey', settingsFor),
      listModels: perRequest('listModels', settingsFor),
      listQuests: perRequest('listQuests', user),
      startReview: perRequest('startReview', user),
      approveQuest: perRequest('approveQuest', user),
      listRuns: perRequest('listRuns', user),
      getRun: perRequest('getRun', user),
      postRun: perRequest('postRun', user),
      decideFindings: perRequest('decideFindings', user),
      discardRun: perRequest('discardRun', user),
      getPlayer: perRequest('getPlayer', user),
      listAchievements: perRequest('listAchievements', user),
      events: userEvents,
    },
    warmUp: async () => {
      try {
        await identity.warmUp();
      } catch (error) {
        warn(
          `Could not open the game yet: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    close: () => {
      deviceFlow.cancel();
      identity.close();
    },
  };
}
