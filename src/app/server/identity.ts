import type { IncomingMessage } from 'node:http';

import { GitHubTokenProvider } from '../../features/auth/server/index.ts';
import type { GitHubViewer } from '../../features/quests/server/index.ts';
import type { SecretStore } from '../../platform/server/secrets.ts';
import type { GitHubAccount } from '../../shared/api.ts';
import {
  type Session,
  type SessionFactory,
  SessionManager,
  type SessionServices,
} from './sessions.ts';
import { type AppStorage, MACHINE_SCOPE, type StorageScope } from './storage.ts';

/**
 * Works out whose game a request acts on. Local mode has one player per machine, the owner of the
 * current GitHub token, whoever sends the request. A hosted resolver reads the request's session
 * cookie instead and keeps a session per signed-in user.
 */
export interface IdentityResolver<TServices extends SessionServices = SessionServices> {
  /**
   * The session `req` acts as, or `undefined` when nobody is signed in. Rejects with
   * `NotSignedInError` or `GitHubApiError` when GitHub can't confirm the sign-in.
   */
  resolve: (req: IncomingMessage) => Promise<Session<TServices> | undefined>;
  /** The session `resolve` last returned for `req`'s user, without looking anything up. */
  peek: (req: IncomingMessage) => Session<TServices> | undefined;
  /**
   * Whose API keys and settings `req` uses. It must not call GitHub, because the settings work
   * before anyone signs in locally. Rejects with `NotSignedInError` when the scope needs a sign-in.
   */
  scope: (req: IncomingMessage) => Promise<StorageScope>;
  /** Whose API keys and settings the session of `login` uses, for its reviews and quests. */
  scopeFor: (login: string) => StorageScope;
  /** Forgets `req`'s sign-in and stops its session; resolves to the account that was signed in. */
  signOut: (req: IncomingMessage) => Promise<GitHubAccount | undefined>;
  /** GitHub answered 401 for `token`: stop any session acting with it. */
  rejected: (token: string) => void;
  /** Opens the default player's game before the first request, where there is one. */
  warmUp: () => Promise<void>;
  /** Stops every session's background work. */
  close: () => void;
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
}

export type IdentityFactory<TServices extends SessionServices> = (
  context: IdentityContext<TServices>,
) => Promise<IdentityResolver<TServices>>;

export interface LocalIdentityOptions<TServices extends SessionServices> extends Omit<
  IdentityContext<TServices>,
  'storage'
> {
  /** The machine's secrets, which hold the OAuth token from "Sign in with GitHub". */
  secrets: SecretStore;
  /** `gh auth token`, the fallback when the player hasn't signed in through PR Quest. */
  ghToken: () => Promise<string | undefined>;
}

/**
 * Local mode: the player is whoever owns the OAuth token saved by "Sign in with GitHub", else the gh
 * CLI's token. Keys and settings are machine-wide, so every scope is `MACHINE_SCOPE`.
 */
export class LocalIdentityResolver<
  TServices extends SessionServices = SessionServices,
> implements IdentityResolver<TServices> {
  private readonly secrets: SecretStore;
  private readonly sessions: SessionManager<TServices>;

  public constructor(options: LocalIdentityOptions<TServices>) {
    const { secrets } = options;
    this.secrets = secrets;
    this.sessions = new SessionManager<TServices>({
      tokens: new GitHubTokenProvider({
        oauthToken: async () => secrets.get('github'),
        ghToken: options.ghToken,
      }),
      fetchViewer: options.fetchViewer,
      create: options.openUser,
      log: options.log,
    });
  }

  public resolve(_req: IncomingMessage): Promise<Session<TServices> | undefined> {
    return this.sessions.current();
  }

  public peek(_req: IncomingMessage): Session<TServices> | undefined {
    return this.sessions.peek();
  }

  public async scope(_req: IncomingMessage): Promise<StorageScope> {
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

  public async signOut(_req: IncomingMessage): Promise<GitHubAccount | undefined> {
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
    this.sessions.close();
  }
}
