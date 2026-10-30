import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import type {
  DifficultyTier,
  RepoRef,
  RequestKind,
  ReviewRun,
  ReviewRunQuest,
} from '../shared/api.ts';
import { initialGameState, type GameState } from './gamification.ts';
import { ReviewResultSchema, type ReviewTarget } from './reviewResult.ts';

const STATE_FILE = 'state.json';

/** The quest as it was when a run started, so posting and rewards work after it leaves the queue. */
export interface QuestSnapshot extends ReviewTarget {
  repo: RepoRef;
  number: number;
  headSha?: string;
  linearUrl?: string;
  difficulty: DifficultyTier;
  requestKind: RequestKind;
  requestedAt: string;
}

/** The part of the snapshot the UI sees on `ReviewRun.quest`. */
export function runQuestOf(snapshot: QuestSnapshot): ReviewRunQuest {
  const quest: ReviewRunQuest = {
    title: snapshot.title,
    repo: snapshot.repo,
    number: snapshot.number,
    githubUrl: snapshot.githubUrl,
  };
  if (snapshot.linearUrl) {
    quest.linearUrl = snapshot.linearUrl;
  }
  return quest;
}

export interface StoredRun {
  run: ReviewRun;
  quest: QuestSnapshot;
}

export interface PersistedState {
  version: 1;
  game: GameState;
  runs: Array<StoredRun>;
}

const CountersSchema = z.object({
  reviewsPosted: z.number().int().nonnegative(),
  approvals: z.number().int().nonnegative(),
  changesRequested: z.number().int().nonnegative(),
  agentReviews: z.number().int().nonnegative(),
  teamReviews: z.number().int().nonnegative(),
  bossesSlain: z.number().int().nonnegative(),
  quickDraws: z.number().int().nonnegative(),
});

const AchievementIdSchema = z.enum([
  'first-blood',
  'quick-draw',
  'boss-slayer',
  'team-player',
  'inbox-zero',
  'on-fire',
  'agent-commander',
]);

const GameStateSchema = z.object({
  xp: z.number().nonnegative(),
  achievements: z.array(z.object({ id: AchievementIdSchema, unlockedAt: z.string() })),
  counters: CountersSchema,
  streakDays: z.number().int().nonnegative(),
  lastReviewDate: z.string().optional(),
  rewardedApprovals: z.array(z.string()),
});

const TierSchema = z.enum(['Trivial', 'Normal', 'Hard', 'Boss']);

const RepoSchema = z.object({ owner: z.string(), name: z.string() });

const StoredRunSchema = z.object({
  run: z.object({
    id: z.string(),
    questId: z.string(),
    /** Absent in state written before runs carried it; filled from `quest` on load. */
    quest: z
      .object({
        title: z.string(),
        repo: RepoSchema,
        number: z.number().int().positive(),
        githubUrl: z.string(),
        linearUrl: z.string().optional(),
      })
      .optional(),
    agentId: z.string().optional(),
    runId: z.string().optional(),
    status: z.enum(['queued', 'running', 'finished', 'error', 'startupFailed']),
    disposition: z.enum(['pending', 'posted', 'discarded']),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    result: ReviewResultSchema.optional(),
    error: z.object({ message: z.string(), retryable: z.boolean().optional() }).optional(),
    postedReviewUrl: z.string().optional(),
  }),
  quest: z.object({
    id: z.string(),
    title: z.string(),
    repo: RepoSchema,
    number: z.number().int().positive(),
    githubUrl: z.string(),
    sourceBranch: z.string(),
    targetBranch: z.string(),
    headSha: z.string().optional(),
    linearUrl: z.string().optional(),
    difficulty: TierSchema,
    requestKind: z.enum(['direct', 'team']),
    requestedAt: z.string(),
  }),
});

const PersistedStateSchema = z.object({
  version: z.literal(1),
  game: GameStateSchema,
  runs: z.array(StoredRunSchema),
});

export interface StateStoreOptions {
  onWarning?: (message: string) => void;
}

/** XP, achievements and review runs in `<stateDir>/state.json`. Writes are serialized and atomic. */
export class StateStore {
  private current: PersistedState;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;

  private constructor(file: string, initial: PersistedState) {
    this.file = file;
    this.current = initial;
  }

  public get state(): PersistedState {
    return this.current;
  }

  public static async open(stateDir: string, options: StateStoreOptions = {}): Promise<StateStore> {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    // `mkdir` leaves an existing directory's mode alone; the state holds review history.
    await chmod(stateDir, 0o700);
    const file = join(stateDir, STATE_FILE);
    return new StateStore(file, await readState(file, options.onWarning ?? (() => undefined)));
  }

  /**
   * Applies `mutate` after any pending update and persists the result before resolving. Returning
   * the same object skips the write.
   */
  public update(mutate: (state: PersistedState) => PersistedState): Promise<PersistedState> {
    const next = this.queue.then(async () => {
      const updated = mutate(this.current);
      if (updated === this.current) {
        return updated;
      }
      await this.write(updated);
      this.current = updated;
      return updated;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async write(state: PersistedState): Promise<void> {
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.file);
  }
}

async function readState(
  file: string,
  onWarning: (message: string) => void,
): Promise<PersistedState> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return emptyState();
    }
    throw error;
  }

  const parsed = PersistedStateSchema.safeParse(safeJson(text));
  if (parsed.success) {
    return {
      ...parsed.data,
      runs: parsed.data.runs.map(({ run, quest }) => ({
        run: { ...run, quest: run.quest ?? runQuestOf(quest) },
        quest,
      })),
    };
  }
  const aside = `${file}.corrupt-${Date.now()}`;
  await rename(file, aside);
  onWarning(`State file was unreadable; moved it to ${aside} and started fresh`);
  return emptyState();
}

function emptyState(): PersistedState {
  return { version: 1, game: initialGameState(), runs: [] };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
