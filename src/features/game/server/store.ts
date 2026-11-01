import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import {
  ACHIEVEMENT_IDS,
  type DiffStats,
  type DifficultyTier,
  type QuestAuthor,
  type RepoRef,
  type RequestKind,
  type ReviewRun,
  type ReviewRunQuest,
} from '../../../shared/api.ts';
import { initialGameState, type GameState } from './gamification.ts';
import {
  emptyLedger,
  isHighSeverity,
  prKey,
  repoKey,
  withEntry,
  withRunProvider,
  type AchievementLedger,
} from './ledger.ts';
import { refuseNewerVersion } from '../../../platform/server/privateFiles.ts';
import { StoredReviewResultSchema, type ReviewTarget } from '../../../shared/reviewResult.ts';

const STATE_FILE = 'state.json';
/** Version 2 added the achievement ledger. */
export const STATE_VERSION = 2;

/** The quest as it was when a run started, so posting and rewards work after it leaves the queue. */
export interface QuestSnapshot extends ReviewTarget {
  repo: RepoRef;
  number: number;
  headSha?: string;
  linearUrl?: string;
  difficulty: DifficultyTier;
  requestKind: RequestKind;
  requestedAt: string;
  /** Absent in runs started before snapshots kept it. */
  author?: QuestAuthor;
  diffStats?: DiffStats;
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
  version: typeof STATE_VERSION;
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

const AchievementIdSchema = z.enum(ACHIEVEMENT_IDS);

const ProviderSchema = z.enum(['cursor', 'claude']);

const LedgerSchema = z.object({
  repos: z.array(z.string()),
  authors: z.array(z.string()),
  botPrs: z.array(z.string()),
  changesRequestedPrs: z.array(z.string()),
  bossApprovals: z.number().int().nonnegative(),
  highSeverityReviews: z.number().int().nonnegative(),
  reviewedPrs: z.array(z.string()),
  runProviders: z.record(z.string(), z.array(ProviderSchema)),
  day: z
    .object({
      date: z.string(),
      trivialApprovals: z.number().int().nonnegative(),
      directPrs: z.array(z.string()),
    })
    .optional(),
});

const GameStateV1Schema = z.object({
  xp: z.number().nonnegative(),
  achievements: z.array(z.object({ id: AchievementIdSchema, unlockedAt: z.string() })),
  counters: CountersSchema,
  streakDays: z.number().int().nonnegative(),
  lastReviewDate: z.string().optional(),
  rewardedApprovals: z.array(z.string()),
});

const GameStateSchema = GameStateV1Schema.extend({ ledger: LedgerSchema });

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
    /** Absent in state written before Claude reviews existed; those runs were Cursor's. */
    provider: ProviderSchema.default('cursor'),
    model: z.string().optional(),
    agentId: z.string().optional(),
    runId: z.string().optional(),
    status: z.enum(['queued', 'running', 'finished', 'error', 'startupFailed']),
    disposition: z.enum(['pending', 'posted', 'discarded']),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    result: StoredReviewResultSchema.optional(),
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
    author: z.object({ name: z.string(), githubLogin: z.string().optional() }).optional(),
    diffStats: z
      .object({
        fileCount: z.number().int().nonnegative(),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
      })
      .optional(),
  }),
});

const PersistedStateSchema = z.object({
  version: z.literal(STATE_VERSION),
  game: GameStateSchema,
  runs: z.array(StoredRunSchema),
});

const PersistedStateV1Schema = z.object({
  version: z.literal(1),
  game: GameStateV1Schema,
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

  const json = safeJson(text);
  refuseNewerVersion(json, STATE_VERSION, file);
  const parsed = PersistedStateSchema.safeParse(json);
  if (parsed.success) {
    return { ...parsed.data, runs: withRunQuests(parsed.data.runs) };
  }
  const legacy = PersistedStateV1Schema.safeParse(json);
  if (legacy.success) {
    await keepCopy(file, `${file}.v1.bak`);
    const runs = withRunQuests(legacy.data.runs);
    const game: GameState = {
      ...legacy.data.game,
      ledger: backfillLedger(legacy.data.game.rewardedApprovals, runs),
    };
    return { version: STATE_VERSION, game, runs };
  }
  const aside = `${file}.corrupt-${Date.now()}`;
  await rename(file, aside);
  onWarning(`State file was unreadable; moved it to ${aside} and started fresh`);
  return emptyState();
}

type ParsedRun = z.infer<typeof StoredRunSchema>;

function withRunQuests(runs: Array<ParsedRun>): Array<StoredRun> {
  return runs.map(({ run, quest }) => ({
    run: { ...run, quest: run.quest ?? runQuestOf(quest) },
    quest,
  }));
}

/**
 * What version 1 state already shows about the achievement ledger: the repos of approved and
 * posted PRs, Boss approvals whose run kept the tier, posted reviews with critical or major
 * findings, and which providers finished a review of each PR. Authors, bots, requests for changes
 * and today's counters weren't stored, so they count from the upgrade on.
 */
export function backfillLedger(
  rewardedApprovals: ReadonlyArray<string>,
  runs: ReadonlyArray<StoredRun>,
): AchievementLedger {
  const ledger = emptyLedger();
  const tiers = new Map(runs.map(({ quest }) => [prKey(quest.id), quest.difficulty]));
  for (const questId of rewardedApprovals) {
    ledger.repos = withEntry(ledger.repos, repoKey(questId));
    if (tiers.get(prKey(questId)) === 'Boss') {
      ledger.bossApprovals++;
    }
  }
  for (const { run, quest } of runs) {
    const key = prKey(quest.id);
    if (run.status === 'finished' && run.result) {
      ledger.reviewedPrs = withEntry(ledger.reviewedPrs, key);
      ledger.runProviders = withRunProvider(ledger.runProviders, key, run.provider);
    }
    if (run.disposition === 'posted') {
      ledger.repos = withEntry(ledger.repos, repoKey(quest.id));
      ledger.reviewedPrs = withEntry(ledger.reviewedPrs, key);
      if (run.result?.findings.some((finding) => isHighSeverity(finding.severity))) {
        ledger.highSeverityReviews++;
      }
    }
  }
  return ledger;
}

/** Copies `file` to `backup` once; a later upgrade never overwrites the first copy. */
async function keepCopy(file: string, backup: string): Promise<void> {
  try {
    await copyFile(file, backup, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return;
    }
    throw error;
  }
  await chmod(backup, 0o600);
}

function emptyState(): PersistedState {
  return { version: STATE_VERSION, game: initialGameState(), runs: [] };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
