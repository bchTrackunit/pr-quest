import type { GitHubAccount } from '../shared/api.ts';
import type { GitHubViewer } from './github.ts';
import { NotSignedInError } from './githubApi.ts';
import type { ResolvedToken } from './githubToken.ts';

/** A failed `/user` lookup is retried after this long rather than on every request. */
const IDENTITY_FAILURE_TTL_MS = 30_000;

/** One player's services: their state, game, reviews and quest polling. */
export interface SessionServices {
  login: string;
  /** Stops background work such as quest polling. */
  stop: () => void;
}

export type SessionFactory<TServices extends SessionServices = SessionServices> = (user: {
  login: string;
}) => Promise<TServices>;

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

interface Identity {
  viewer: Promise<GitHubViewer>;
  expiresAt?: number;
}

/**
 * Whose game is on screen: the owner of the current GitHub token. Each user gets their own
 * services; switching users stops the previous user's.
 */
export class SessionManager<TServices extends SessionServices = SessionServices> {
  private readonly options: SessionManagerOptions<TServices>;
  private readonly now: () => number;
  private readonly identities = new Map<string, Identity>();
  private open?: { login: string; services: Promise<TServices> };
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
    const viewer = await this.identify(token.token);
    const services = await this.servicesFor(viewer.login.toLowerCase());
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

  /** Call after signing in or out: the next lookup re-reads the token and its owner. */
  public reset(): void {
    this.identities.clear();
    this.options.tokens.invalidate();
  }

  /** Stops the open session's background work, e.g. on shutdown. */
  public close(): void {
    const open = this.open;
    if (!open) {
      return;
    }
    this.open = undefined;
    this.latest = undefined;
    void open.services.then(
      (services) => services.stop(),
      () => undefined,
    );
  }

  private identify(token: string): Promise<GitHubViewer> {
    const cached = this.identities.get(token);
    if (cached && (cached.expiresAt === undefined || this.now() < cached.expiresAt)) {
      return cached.viewer;
    }
    const identity: Identity = { viewer: this.options.fetchViewer(token) };
    identity.viewer.catch(() => {
      identity.expiresAt = this.now() + IDENTITY_FAILURE_TTL_MS;
    });
    this.identities.set(token, identity);
    return identity.viewer;
  }

  private servicesFor(login: string): Promise<TServices> {
    if (this.open?.login === login) {
      return this.open.services;
    }
    this.close();
    this.options.log(`Opening ${login}'s game`);
    const services = this.options.create({ login });
    const open = { login, services };
    this.open = open;
    services.catch(() => {
      if (this.open === open) {
        this.open = undefined;
      }
    });
    return services;
  }
}
