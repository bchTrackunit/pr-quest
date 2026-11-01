import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import type { Quest, QuestSource } from '../../../shared/api.ts';
import type { Backoff } from '../../../platform/server/rateLimit.ts';

const CACHE_FILE = 'quests.json';

/** The last quest list read from GitHub. */
export interface QuestSnapshot {
  quests: Array<Quest>;
  fetchedAt: Date;
  source: QuestSource;
}

/** What survives a restart: the last good quest list and any rate-limit backoff in progress. */
export interface CachedQuestState {
  snapshot?: QuestSnapshot;
  backoff?: Backoff;
}

const RepoSchema = z.object({ owner: z.string(), name: z.string() });

const QuestSchema = z.object({
  id: z.string(),
  title: z.string(),
  repo: RepoSchema,
  number: z.number().int().positive(),
  author: z.object({ name: z.string(), githubLogin: z.string().optional() }),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  headSha: z.string().optional(),
  status: z.enum(['draft', 'open', 'inReview', 'approved', 'merged', 'closed']),
  isDraft: z.boolean(),
  approvedByOthers: z.boolean(),
  approvalCount: z.number().int().nonnegative(),
  diffStats: z.object({
    fileCount: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
  difficulty: z.enum(['Trivial', 'Normal', 'Hard', 'Boss']),
  requestKind: z.enum(['direct', 'team']),
  requestedTeams: z.array(z.string()),
  needsAttention: z.boolean(),
  githubUrl: z.string(),
  linearUrl: z.string().optional(),
  openedAt: z.string(),
  updatedAt: z.string(),
  requestedAt: z.string(),
  source: z.enum(['linear', 'github']),
});

const IsoDateSchema = z.iso.datetime({ offset: true });

const CacheFileSchema = z.object({
  version: z.literal(1),
  snapshot: z
    .object({
      quests: z.array(QuestSchema),
      fetchedAt: IsoDateSchema,
      source: z.enum(['linear', 'github']),
    })
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

export interface QuestCacheOptions {
  onWarning?: (message: string) => void;
}

/** `<stateDir>/quests.json`. Writes are serialized and atomic; an unreadable file is ignored. */
export class QuestCache {
  private readonly file: string;
  private readonly stateDir: string;
  private readonly onWarning: (message: string) => void;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(stateDir: string, options: QuestCacheOptions = {}) {
    this.stateDir = stateDir;
    this.file = join(stateDir, CACHE_FILE);
    this.onWarning = options.onWarning ?? (() => undefined);
  }

  public async load(): Promise<CachedQuestState> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        this.onWarning(
          `Could not read the quest cache: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {};
    }
    const parsed = CacheFileSchema.safeParse(safeJson(text));
    if (!parsed.success) {
      this.onWarning('The quest cache was unreadable; ignoring it');
      return {};
    }
    return fromFile(parsed.data);
  }

  public save(state: CachedQuestState): Promise<void> {
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

function toFile({ snapshot, backoff }: CachedQuestState): CacheFile {
  const file: CacheFile = { version: 1 };
  if (snapshot) {
    file.snapshot = {
      quests: snapshot.quests,
      fetchedAt: snapshot.fetchedAt.toISOString(),
      source: snapshot.source,
    };
  }
  if (backoff) {
    file.backoff = { ...backoff, limitedUntil: backoff.limitedUntil.toISOString() };
  }
  return file;
}

function fromFile({ snapshot, backoff }: CacheFile): CachedQuestState {
  const state: CachedQuestState = {};
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
