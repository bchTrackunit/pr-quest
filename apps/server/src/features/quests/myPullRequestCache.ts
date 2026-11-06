import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import type { MyPullRequest } from '@pr-quest/contract/api';
import type { Backoff } from '../../platform/rateLimit.ts';

const CACHE_FILE = 'my-prs.json';

/** The last list of the player's open PRs read from GitHub. */
export interface MyPullRequestSnapshot {
  pullRequests: Array<MyPullRequest>;
  fetchedAt: Date;
}

export interface CachedMyPullRequestState {
  snapshot?: MyPullRequestSnapshot;
  backoff?: Backoff;
}

const MyPullRequestSchema = z.object({
  id: z.string(),
  title: z.string(),
  repo: z.object({ owner: z.string(), name: z.string() }),
  number: z.number().int().positive(),
  githubUrl: z.string(),
  author: z.object({ name: z.string(), githubLogin: z.string().optional() }),
  authorAssociation: z.string().optional(),
  isCrossRepository: z.boolean().optional(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  headSha: z.string(),
  isDraft: z.boolean(),
  diffStats: z.object({
    fileCount: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
  difficulty: z.enum(['Trivial', 'Normal', 'Hard', 'Boss']),
  openedAt: z.string(),
  updatedAt: z.string(),
  reviewState: z.enum(['approved', 'changesRequested', 'waiting']),
  ciState: z.enum(['passing', 'failing', 'running', 'none', 'unknown']),
  mergeState: z.enum(['clean', 'conflicting', 'behind', 'unknown']),
  unresolvedThreads: z.number().int().nonnegative(),
  moreThreads: z.literal(true).optional(),
  needsMyAction: z.boolean(),
});

const IsoDateSchema = z.iso.datetime({ offset: true });

const CacheFileSchema = z.object({
  version: z.literal(1),
  snapshot: z
    .object({ pullRequests: z.array(MyPullRequestSchema), fetchedAt: IsoDateSchema })
    .optional(),
  backoff: z
    .object({
      kind: z.enum(['primary', 'secondary']),
      limitedUntil: IsoDateSchema,
      attempt: z.number().int().positive(),
    })
    .optional(),
});

type CacheFile = z.infer<typeof CacheFileSchema>;

/** The player's PR list and backoff across restarts. Losing them only costs a GitHub refresh. */
export interface MyPullRequestCache {
  /** Resolves to `{}` rather than rejecting when there is nothing usable. */
  load: () => Promise<CachedMyPullRequestState>;
  save: (state: CachedMyPullRequestState) => Promise<void>;
}

export interface MyPullRequestCacheOptions {
  onWarning?: (message: string) => void;
}

/** `<stateDir>/my-prs.json`. Writes are serialized and atomic; an unreadable file is ignored. */
export class FileMyPullRequestCache implements MyPullRequestCache {
  private readonly file: string;
  private readonly stateDir: string;
  private readonly onWarning: (message: string) => void;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(stateDir: string, options: MyPullRequestCacheOptions = {}) {
    this.stateDir = stateDir;
    this.file = join(stateDir, CACHE_FILE);
    this.onWarning = options.onWarning ?? (() => undefined);
  }

  public async load(): Promise<CachedMyPullRequestState> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        this.onWarning(
          `Could not read the My PRs cache: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {};
    }
    const parsed = CacheFileSchema.safeParse(safeJson(text));
    if (!parsed.success) {
      this.onWarning('The My PRs cache was unreadable; ignoring it');
      return {};
    }
    return fromFile(parsed.data);
  }

  public save(state: CachedMyPullRequestState): Promise<void> {
    const next = this.queue.then(async () => {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, `${JSON.stringify(toFile(state))}\n`, { mode: 0o600 });
      await rename(temp, this.file);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function toFile({ snapshot, backoff }: CachedMyPullRequestState): CacheFile {
  const file: CacheFile = { version: 1 };
  if (snapshot) {
    file.snapshot = {
      pullRequests: snapshot.pullRequests.map(({ activeRunId: _run, ...pr }) => pr),
      fetchedAt: snapshot.fetchedAt.toISOString(),
    };
  }
  if (backoff) {
    file.backoff = { ...backoff, limitedUntil: backoff.limitedUntil.toISOString() };
  }
  return file;
}

function fromFile({ snapshot, backoff }: CacheFile): CachedMyPullRequestState {
  const state: CachedMyPullRequestState = {};
  if (snapshot) {
    state.snapshot = { ...snapshot, fetchedAt: new Date(snapshot.fetchedAt) };
  }
  if (backoff) {
    state.backoff = { ...backoff, limitedUntil: new Date(backoff.limitedUntil) };
  }
  return state;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
