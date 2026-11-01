import type { GitHubTokenSource } from '../../../shared/api.ts';

const GH_CACHE_MS = 5 * 60_000;

export interface ResolvedToken {
  token: string;
  source: GitHubTokenSource;
}

export interface GitHubTokenProviderOptions {
  /** The token from "Sign in with GitHub", if the player signed in. */
  oauthToken: () => Promise<string | undefined>;
  /** `gh auth token`, the fallback for players who use the GitHub CLI. */
  ghToken: () => Promise<string | undefined>;
  now?: () => number;
}

/** Which GitHub token PR Quest acts with: the signed-in OAuth token first, then the gh CLI's. */
export class GitHubTokenProvider {
  private readonly oauthToken: () => Promise<string | undefined>;
  private readonly ghToken: () => Promise<string | undefined>;
  private readonly now: () => number;
  /** Spawning gh per request would be slow, so its answer (even "none") is kept for a while. */
  private ghCache?: { expiresAt: number; token: Promise<string | undefined> };

  public constructor(options: GitHubTokenProviderOptions) {
    this.oauthToken = options.oauthToken;
    this.ghToken = options.ghToken;
    this.now = options.now ?? Date.now;
  }

  public async resolve(): Promise<ResolvedToken | undefined> {
    const oauth = await this.oauthToken();
    if (oauth) {
      return { token: oauth, source: 'oauth' };
    }
    const gh = await this.cachedGhToken();
    return gh ? { token: gh, source: 'gh' } : undefined;
  }

  public async token(): Promise<string | undefined> {
    return (await this.resolve())?.token;
  }

  /** Forgets the gh answer, e.g. after signing out or when GitHub rejected the token. */
  public invalidate(): void {
    this.ghCache = undefined;
  }

  private cachedGhToken(): Promise<string | undefined> {
    const nowMs = this.now();
    if (!this.ghCache || nowMs >= this.ghCache.expiresAt) {
      this.ghCache = { expiresAt: nowMs + GH_CACHE_MS, token: this.ghToken() };
    }
    return this.ghCache.token;
  }
}
