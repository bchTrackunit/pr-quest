import type { GitHubAccount, GitHubTokenSource } from '../shared/api.ts';
import type { GitHubViewer } from './github.ts';
import { GitHubApiError, NotSignedInError } from './githubApi.ts';
import type { ResolvedToken } from './githubToken.ts';

/** A failed `/user` lookup is retried after this long rather than on every request. */
const IDENTITY_FAILURE_TTL_MS = 30_000;
/** A revoked token stops showing as signed in after at most this long, even without a 401. */
const IDENTITY_TTL_MS = 10 * 60_000;

/** One player's services: their state, game, reviews and quest polling. */
export interface SessionServices {
  login: string;
  /** Stops background work such as quest polling. */
  stop: () => void;
}

/** What a session acts with. Every GitHub call must take its token from `token()`. */
export interface SessionContext {
  login: string;
  /**
   * The token this session was opened with. Rejects with `SessionEndedError` once the session is
   * closed or the current token is someone else's, so a call never goes out as another account.
   */
  token: () => Promise<string>;
}

export type SessionFactory<TServices extends SessionServices = SessionServices> = (
  context: SessionContext,
) => Promise<TServices>;

export interface Session<TServices extends SessionServices = SessionServices> {
  account: GitHubAccount;
  services: TServices;
}

export interface SessionManagerOptions<TServices extends SessionServices> {
  tokens: { resolve: () => Promise<ResolvedToken | undefined>; invalidate: () => void };
  /** `GET /user` with the given token. */
  fetchViewer: (token: string) => Promise<GitHubViewer>;
  create: SessionFactory<TServices>;
  log: (message: string) => void;
  now?: () => number;
}

/** The GitHub sign-in changed after this session was opened, so its call was not sent. */
export class SessionEndedError extends NotSignedInError {
  public constructor(login: string) {
    super(
      `The GitHub sign-in changed, so nothing was sent as @${login}. Reload to continue as the current account.`,
    );
    this.name = 'SessionEndedError';
  }
}

interface Identity {
  viewer: Promise<GitHubViewer>;
  expiresAt: number;
}

interface Binding {
  login: string;
  /** Moves to a new token only after `/user` showed it belongs to the same login. */
  token: string;
  closed: boolean;
}

interface OpenSession<TServices> {
  binding: Binding;
  services: Promise<TServices>;
}

/**
 * Whose game is on screen: the owner of the current GitHub token. Each user gets their own
 * services, bound to their token; switching users or signing out stops the previous user's.
 */
export class SessionManager<TServices extends SessionServices = SessionServices> {
  private readonly options: SessionManagerOptions<TServices>;
  private readonly now: () => number;
  private readonly identities = new Map<string, Identity>();
  private open?: OpenSession<TServices>;
  private latest?: Session<TServices>;

  public constructor(options: SessionManagerOptions<TServices>) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** The current token owner's session, or `undefined` when there is no token. */
  public async current(): Promise<Session<TServices> | undefined> {
    const token = await this.options.tokens.resolve();
    if (!token) {
      this.close();
      return undefined;
    }
    const viewer = await this.identify(token);
    const services = await this.servicesFor(viewer.login.toLowerCase(), token.token);
    const account: GitHubAccount = { login: viewer.login, tokenSource: token.source };
    if (viewer.name) {
      account.name = viewer.name;
    }
    if (viewer.avatarUrl) {
      account.avatarUrl = viewer.avatarUrl;
    }
    this.latest = { account, services };
    return this.latest;
  }

  public async require(): Promise<Session<TServices>> {
    const session = await this.current();
    if (!session) {
      throw new NotSignedInError();
    }
    return session;
  }

  /** The last session `current()` returned, without looking anything up. */
  public peek(): Session<TServices> | undefined {
    return this.latest;
  }

  /**
   * Call after signing in or out: the open session stops now, and the next lookup re-reads the
   * token and its owner.
   */
  public reset(): void {
    this.identities.clear();
    this.options.tokens.invalidate();
    this.close();
  }

  /** GitHub answered 401 for `token`: forget its owner and stop the session acting with it. */
  public rejected(token: string): void {
    this.identities.delete(token);
    this.options.tokens.invalidate();
    if (this.open?.binding.token === token) {
      this.close();
    }
  }

  /** Stops the open session's background work and refuses its further GitHub calls. */
  public close(): void {
    const open = this.open;
    if (!open) {
      return;
    }
    open.binding.closed = true;
    this.open = undefined;
    this.latest = undefined;
    void open.services.then(
      (services) => services.stop(),
      () => undefined,
    );
  }

  private async identify(token: ResolvedToken): Promise<GitHubViewer> {
    try {
      return await this.lookUp(token.token);
    } catch (error) {
      if (error instanceof GitHubApiError && error.httpStatus === 401) {
        throw new NotSignedInError(rejectedMessage(token.source));
      }
      throw error;
    }
  }

  private lookUp(token: string): Promise<GitHubViewer> {
    const cached = this.identities.get(token);
    if (cached && this.now() < cached.expiresAt) {
      return cached.viewer;
    }
    const identity: Identity = {
      viewer: this.options.fetchViewer(token),
      expiresAt: this.now() + IDENTITY_TTL_MS,
    };
    identity.viewer.catch(() => {
      identity.expiresAt = this.now() + IDENTITY_FAILURE_TTL_MS;
    });
    this.identities.set(token, identity);
    return identity.viewer;
  }

  private servicesFor(login: string, token: string): Promise<TServices> {
    if (this.open?.binding.login === login) {
      this.open.binding.token = token;
      return this.open.services;
    }
    this.close();
    this.options.log(`Opening ${login}'s game`);
    const binding: Binding = { login, token, closed: false };
    const open = {
      binding,
      services: this.options.create({ login, token: () => this.tokenFor(binding) }),
    };
    this.open = open;
    open.services.catch(() => {
      if (this.open === open) {
        this.open = undefined;
      }
    });
    return open.services;
  }

  private async tokenFor(binding: Binding): Promise<string> {
    const current = await this.options.tokens.resolve();
    if (!current) {
      throw new NotSignedInError();
    }
    if (binding.closed || current.token !== binding.token) {
      throw new SessionEndedError(binding.login);
    }
    return current.token;
  }
}

function rejectedMessage(source: GitHubTokenSource): string {
  return source === 'oauth'
    ? 'GitHub rejected the saved sign-in (it may have been revoked). Sign in with GitHub again in Settings.'
    : 'GitHub rejected the gh CLI token. Run `gh auth login` again, or sign in with GitHub in Settings.';
}
