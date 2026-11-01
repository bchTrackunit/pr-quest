import type { IncomingMessage, ServerResponse } from 'node:http';

import { DeviceFlow, GitHubTokenProvider } from '../../features/auth/server/index.ts';
import type { GitHubViewer } from '../../features/quests/server/index.ts';
import type { FetchLike } from '../../platform/server/githubApi.ts';
import type { RawRoute } from '../../platform/server/router.ts';
import type { SecretStore } from '../../platform/server/secrets.ts';
import type { GitHubAccount } from '../../shared/api.ts';
import {
  type Session,
  type SessionFactory,
  SessionManager,
  type SessionServices,
} from './sessions.ts';
import { type AppStorage, MACHINE_SCOPE, type StorageScope } from './storage.ts';

/** "Sign in with GitHub" by device code, which needs no callback; local mode offers it. */
export type DeviceSignIn = Pick<
  DeviceFlow,
  'start' | 'status' | 'cancel' | 'acknowledgeComplete' | 'isConfigured'
>;

/**
 * Works out whose game a request acts on. Local mode has one player per machine, the owner of the
 * current GitHub token, whoever sends the request. A hosted resolver reads the request's session
 * cookie instead, keeps a session per signed-in user, and sets or clears the cookie on `res`.
 */
export interface IdentityResolver<TServices extends SessionServices = SessionServices> {
  /**
   * The session `req` acts as, or `undefined` when nobody is signed in. Rejects with
   * `NotSignedInError` or `GitHubApiError` when GitHub can't confirm the sign-in. It may set
   * headers on `res`, which hasn't been written yet.
   */
  resolve: (req: IncomingMessage, res: ServerResponse) => Promise<Session<TServices> | undefined>;
  /**
   * Whose API keys and settings `req` uses. It must not call GitHub, because the settings work
   * before anyone signs in locally. Rejects with `NotSignedInError` when the scope needs a sign-in.
   */
  scope: (req: IncomingMessage, res: ServerResponse) => Promise<StorageScope>;
  /** Whose API keys and settings the session of `login` uses, for its reviews and quests. */
  scopeFor: (login: string) => StorageScope;
  /**
   * Forgets `req`'s sign-in and stops its session; resolves to the account that was signed in. A
   * hosted resolver clears its cookie on `res`. Local mode then calls `resolve` on the same request
   * to report who is signed in now: that must never return the signed-out session or set a cookie
   * for it, only a sign-in that still holds, such as the gh CLI's token.
   */
  signOut: (req: IncomingMessage, res: ServerResponse) => Promise<GitHubAccount | undefined>;
  /** GitHub answered 401 for `token`: stop any session acting with it. */
  rejected: (token: string) => void;
  /** Opens the default player's game before the first request, where there is one. */
  warmUp: () => Promise<void>;
  /** Stops every session's background work. */
  close: () => void;
  /** Routes the sign-in needs outside the JSON API, such as an OAuth redirect and its callback. */
  routes?: ReadonlyArray<RawRoute>;
  /** Without one, the device flow routes say sign-in isn't configured. */
  deviceFlow?: DeviceSignIn;
}

/** What `createApp` gives the identity resolver it builds. */
export interface IdentityContext<TServices extends SessionServices> {
  /**
   * Opens one player's services. Call it once per session, never for two sessions of the same
   * login at once, and `stop()` the services when that session ends.
   */
  openUser: SessionFactory<TServices>;
  /** `GET /user` with the given token. */
  fetchViewer: (token: string) => Promise<GitHubViewer>;
  storage: AppStorage;
  log: (message: string) => void;
  warn: (message: string) => void;
  /**
   * Forgets `login`'s game store and per-user keys and settings, so the next `openUser` reads them
   * from storage again, for example to evict an idle player. Call it only once every session of
   * `login` has stopped and its review runs have finished, or a run still finishing would write to
   * the forgotten store over the reopened one.
   */
  releaseUser: (login: string) => void;
}

export type IdentityFactory<TServices extends SessionServices> = (
  context: IdentityContext<TServices>,
) => Promise<IdentityResolver<TServices>>;

export interface LocalIdentityOptions<TServices extends SessionServices> extends Omit<
  IdentityContext<TServices>,
  'storage' | 'releaseUser'
> {
  /** The machine's secrets, which hold the OAuth token from "Sign in with GitHub". */
  secrets: SecretStore;
  /** `gh auth token`, the fallback when the player hasn't signed in through PR Quest. */
  ghToken: () => Promise<string | undefined>;
  /** The OAuth App for the device flow; without one, starting it says how to set one up. */
  githubClientId?: string;
  /** For the device flow's calls to github.com. */
  fetch?: FetchLike;
}

/**
 * Local mode: the player is whoever owns the OAuth token saved by "Sign in with GitHub", else the gh
 * CLI's token. Keys and settings are machine-wide, so every scope is `MACHINE_SCOPE`.
 */
export class LocalIdentityResolver<
  TServices extends SessionServices = SessionServices,
> implements IdentityResolver<TServices> {
  public readonly deviceFlow: DeviceFlow;
  private readonly secrets: SecretStore;
  private readonly sessions: SessionManager<TServices>;

  public constructor(options: LocalIdentityOptions<TServices>) {
    const { secrets, fetchViewer } = options;
    this.secrets = secrets;
    this.sessions = new SessionManager<TServices>({
      tokens: new GitHubTokenProvider({
        oauthToken: async () => secrets.get('github'),
        ghToken: options.ghToken,
      }),
      fetchViewer,
      create: options.openUser,
      log: options.log,
    });
    this.deviceFlow = new DeviceFlow({
      clientId: options.githubClientId,
      onToken: async (token, { isCurrent }) => {
        await fetchViewer(token);
        if (!isCurrent()) {
          return;
        }
        await this.signIn(token);
      },
      log: options.warn,
      fetch: options.fetch,
    });
  }

  public resolve(
    _req: IncomingMessage,
    _res: ServerResponse,
  ): Promise<Session<TServices> | undefined> {
    return this.sessions.current();
  }

  public async scope(_req: IncomingMessage, _res: ServerResponse): Promise<StorageScope> {
    return MACHINE_SCOPE;
  }

  public scopeFor(_login: string): StorageScope {
    return MACHINE_SCOPE;
  }

  /** Saves the OAuth token from the device flow; the next lookup acts as its owner. */
  public async signIn(token: string): Promise<void> {
    await this.secrets.set('github', token);
    this.sessions.reset();
  }

  public async signOut(
    _req: IncomingMessage,
    _res: ServerResponse,
  ): Promise<GitHubAccount | undefined> {
    this.deviceFlow.cancel();
    const account = this.sessions.peek()?.account;
    await this.secrets.delete('github');
    this.sessions.reset();
    return account;
  }

  public rejected(token: string): void {
    this.sessions.rejected(token);
  }

  public async warmUp(): Promise<void> {
    await this.sessions.current();
  }

  public close(): void {
    this.deviceFlow.cancel();
    this.sessions.close();
  }
}
