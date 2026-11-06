import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SDKModel } from '@cursor/sdk';

import {
  type AuthServices,
  createAuthHandlers,
  createSettingsHandlers,
} from './accountHandlers.ts';
import { ApiKeys, ModelCatalog, type SettingsStore } from '../features/settings/index.ts';
import { ClaudeReviewer, type CreateMessage, ReviewRunService } from '../features/reviews/index.ts';
import { type AppConfig, assertSafeConfig } from '../platform/config.ts';
import { EventHub } from '../platform/events.ts';
import { GameService, type StateStore } from '../features/game/index.ts';
import {
  GitHubClient,
  LinearReviewClient,
  MyPullRequestService,
  QuestService,
} from '../features/quests/index.ts';
import {
  GitHubApi,
  GitHubApiError,
  NotSignedInError,
  type FetchLike,
} from '../platform/githubApi.ts';
import { createHandlers, type AppServices } from './handlers.ts';
import type { ApiKeyName, RouteName } from '@pr-quest/contract/api';
import {
  ApiError,
  type EventsHandler,
  type RawRoute,
  type RouteHandler,
  type RouteHandlers,
} from '../platform/router.ts';
import type { SecretStore } from '../platform/secrets.ts';
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

type HandlersFor = (req: IncomingMessage, res: ServerResponse) => Promise<RouteHandlers>;

/** Answers `name` with the handler that `handlersFor` picks for the request. */
function perRequest<TName extends JsonRouteName>(
  name: TName,
  handlersFor: HandlersFor,
): RouteHandler<TName> {
  return async (context) => {
    const handlers: JsonRouteHandlers = await handlersFor(context.req, context.res);
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
  /** The identity resolver's routes outside the JSON API, for `RouterOptions.routes`. */
  routes: ReadonlyArray<RawRoute>;
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
  const hosted = config.mode === 'hosted';
  if (hosted && (!options.identity || !options.storage)) {
    throw new Error(
      "Hosted mode needs an identity resolver and storage for many users. This build only has local mode's, which would let anyone act as the server's GitHub account.",
    );
  }
  const storage = options.storage ?? createFileStorage(config.stateDir, { info, warn });
  const envKeys: Partial<Record<ApiKeyName, string>> = hosted
    ? {}
    : {
        cursor: config.cursorApiKey,
        anthropic: config.anthropicApiKey,
        linear: config.linearApiKey,
      };

  const openScope = async (scope: StorageScope): Promise<ScopedServices> => {
    if (hosted && scope.kind === 'machine') {
      throw new Error(
        "Hosted mode keeps keys and settings per player, but the identity resolver asked for the machine's",
      );
    }
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
  const machine = hosted ? undefined : await servicesFor(MACHINE_SCOPE);

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
    // First, so a scope the app refuses leaves the player's game unopened.
    const scoped = await servicesFor(identity.scopeFor(login));
    let opening = stores.get(login);
    const firstOpen = opening === undefined;
    if (!opening) {
      opening = storage.gameState(login);
      stores.set(login, opening);
      opening.catch(() => stores.delete(login));
    }
    const [store, cache, myPullRequestCache] = await Promise.all([
      opening,
      storage.questCache(login),
      storage.myPullRequestCache(login),
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
      github,
      log: info,
    });
    const quests = new QuestService({
      github,
      linear: scoped.linear,
      events,
      game,
      activeRunIdFor: (questId) => runs.activeRunIdFor(questId),
      log: warn,
      login,
      cache,
    });
    const myPullRequests = new MyPullRequestService({
      github,
      events,
      game,
      activeRunIdFor: (prId) => runs.activeRunIdFor(prId),
      log: warn,
      cache: myPullRequestCache,
    });
    await Promise.all([quests.restore(), myPullRequests.restore()]);
    if (firstOpen) {
      // A reopened game's active runs are still followed by the session that started them.
      await runs.resumeInterrupted();
    }
    const stopPolling = [quests.startPolling(), myPullRequests.startPolling()];
    return {
      login,
      quests,
      myPullRequests,
      runs,
      game,
      github,
      events,
      stop: () => {
        stopPolling.forEach((stop) => stop());
        events.close();
      },
    };
  };

  const releaseUser = (login: string): void => {
    stores.delete(login);
    const scope = identity.scopeFor(login);
    if (scope.kind === 'user') {
      scopes.delete(scopeKey(scope));
    }
  };

  const context: IdentityContext<UserServices> = {
    openUser,
    fetchViewer,
    storage,
    log: info,
    warn,
    releaseUser,
  };
  let identity: IdentityResolver<UserServices>;
  if (options.identity) {
    identity = await options.identity(context);
  } else {
    if (!machine) {
      throw new Error('Only local mode has a default identity resolver');
    }
    identity = new LocalIdentityResolver({
      ...context,
      secrets: machine.secrets,
      ghToken: options.ghToken ?? (async () => undefined),
      githubClientId: config.githubClientId,
      fetch: options.fetch,
    });
  }
  const routes = identity.routes ?? [];
  const crossSite = routes.find((route) => route.crossSite);
  if (!hosted && crossSite) {
    identity.close();
    throw new Error(
      `${crossSite.method} ${crossSite.path} is cross-site, which only hosted mode allows: local mode acts as the player's GitHub account`,
    );
  }

  const auth = (req: IncomingMessage, res: ServerResponse): AuthServices['auth'] => {
    let signedOut = false;
    return {
      current: async () => {
        // Only local mode has another sign-in to fall back to; a hosted resolver asked again would
        // still find the signed-out session's cookie on this request.
        if (signedOut && hosted) {
          return {};
        }
        try {
          const session = await identity.resolve(req, res);
          return session ? { account: session.account } : {};
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
      signOut: async () => {
        const account = await identity.signOut(req, res);
        signedOut = true;
        return account?.tokenSource === 'oauth' ? { signedOutLogin: account.login } : {};
      },
    };
  };
  const authFor: HandlersFor = async (req, res) =>
    createAuthHandlers({ deviceFlow: identity.deviceFlow, auth: auth(req, res) });

  const settingsHandlers = new WeakMap<ScopedServices, RouteHandlers>();
  const settingsFor: HandlersFor = async (req, res) => {
    const scope = await identity.scope(req, res).catch(signInFailure);
    const scoped = await servicesFor(scope);
    let handlers = settingsHandlers.get(scoped);
    if (!handlers) {
      handlers = createSettingsHandlers(scoped);
      settingsHandlers.set(scoped, handlers);
    }
    return handlers;
  };

  const gameHandlers = new WeakMap<UserServices, RouteHandlers>();
  const user: HandlersFor = async (req, res) => {
    const session = await identity.resolve(req, res).catch(signInFailure);
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
    user(eventsContext.req, eventsContext.res).then(
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
      // Anyone can reach a hosted health check, so it says nothing about keys.
      health: () =>
        machine
          ? {
              ok: true,
              config: {
                linearApiKey: machine.apiKeys.status('linear').set,
                cursorApiKey: machine.apiKeys.status('cursor').set,
                anthropicApiKey: machine.apiKeys.status('anthropic').set,
              },
            }
          : { ok: true },
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
      listMyPullRequests: perRequest('listMyPullRequests', user),
      startSelfReview: perRequest('startSelfReview', user),
      approveQuest: perRequest('approveQuest', user),
      listRuns: perRequest('listRuns', user),
      getRun: perRequest('getRun', user),
      postRun: perRequest('postRun', user),
      selectFindings: perRequest('selectFindings', user),
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
    routes,
    close: () => {
      identity.close();
    },
  };
}
