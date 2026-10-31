import { randomUUID } from 'node:crypto';
import { Agent, CursorAgentError, type Run, type RunResult, type SDKAgent } from '@cursor/sdk';

import type {
  Quest,
  ReviewProvider,
  ReviewResult,
  ReviewRun,
  ReviewRunStatus,
} from '../shared/api.ts';
import { ClaudeReviewError, DEFAULT_CLAUDE_MODEL, type ClaudeRunner } from './claudeReview.ts';
import type { EventSink, GameService } from './game.ts';
import { buildReviewPrompt, parseReviewResult } from './reviewResult.ts';
import { ApiError } from './router.ts';
import type { AppSettings } from './settings.ts';
import { runQuestOf, type QuestSnapshot, type StateStore, type StoredRun } from './store.ts';

const ACTIVE_STATUSES: ReadonlyArray<ReviewRunStatus> = ['queued', 'running'];
const MAX_STORED_RUNS = 200;
const DEFAULT_SETTINGS: AppSettings = { reviewProvider: 'cursor', models: {} };

export type { ClaudeRunner };

export interface ReviewRunServiceOptions {
  store: StateStore;
  events: EventSink;
  game: Pick<GameService, 'recordAgentReviewFinished'>;
  /** Read per review, so a key saved in the settings takes effect without a restart. */
  cursorApiKey: () => string | undefined;
  /** The selected provider and models; Cursor with its default model when omitted. */
  settings?: () => AppSettings;
  claude?: ClaudeRunner;
  log: (message: string) => void;
  now?: () => Date;
  newId?: () => string;
}

export interface StartReviewOptions {
  model?: string;
}

const isActive = (run: ReviewRun): boolean => ACTIVE_STATUSES.includes(run.status);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Launches reviews by Cursor cloud agents or Claude, tracks their runs and persists them across
 * restarts. Both providers review the quest's head commit and share the run lifecycle.
 */
export class ReviewRunService {
  private readonly store: StateStore;
  private readonly events: EventSink;
  private readonly game: Pick<GameService, 'recordAgentReviewFinished'>;
  private readonly cursorApiKey: () => string | undefined;
  private readonly settings: () => AppSettings;
  private readonly claude?: ClaudeRunner;
  private readonly log: (message: string) => void;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly tasks = new Set<Promise<void>>();
  private readonly posting = new Set<string>();

  public constructor(options: ReviewRunServiceOptions) {
    this.store = options.store;
    this.events = options.events;
    this.game = options.game;
    this.cursorApiKey = options.cursorApiKey;
    this.settings = options.settings ?? (() => DEFAULT_SETTINGS);
    this.claude = options.claude;
    this.log = options.log;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `review-${randomUUID()}`);
  }

  /** Newest first. */
  public list(): Array<ReviewRun> {
    return this.store.state.runs.map((entry) => entry.run).reverse();
  }

  public get(id: string): StoredRun | undefined {
    return this.store.state.runs.find((entry) => entry.run.id === id);
  }

  /** The newest run for the quest that is queued, running or awaiting the player's decision. */
  public activeRunIdFor(questId: string): string | undefined {
    return this.store.state.runs.findLast(
      (entry) => entry.run.questId === questId && entry.run.disposition === 'pending',
    )?.run.id;
  }

  /** Throws `missingConfig` naming the provider when the selected provider has no key. */
  public assertReady(): void {
    this.launcherFor(this.settings().reviewProvider);
  }

  public async start(quest: Quest, options: StartReviewOptions = {}): Promise<ReviewRun> {
    const settings = this.settings();
    const provider = settings.reviewProvider;
    const launch = this.launcherFor(provider);
    const model =
      options.model ??
      settings.models[provider] ??
      (provider === 'claude' ? DEFAULT_CLAUDE_MODEL : undefined);
    const { headSha } = quest;
    if (!headSha) {
      throw new ApiError(
        409,
        'conflict',
        `The head commit of ${quest.id} is unknown. Refresh the board, then send the agent again.`,
      );
    }
    const snapshot = snapshotOf(quest);
    const stored: StoredRun = {
      run: {
        id: this.newId(),
        questId: quest.id,
        quest: runQuestOf(snapshot),
        provider,
        ...(model ? { model } : {}),
        status: 'queued',
        disposition: 'pending',
        startedAt: this.now().toISOString(),
      },
      quest: snapshot,
    };
    await this.store.update((state) => {
      if (state.runs.some((entry) => entry.run.questId === quest.id && isActive(entry.run))) {
        throw new ApiError(409, 'conflict', `A review is already running for ${quest.id}`);
      }
      return { ...state, runs: [...state.runs, stored].slice(-MAX_STORED_RUNS) };
    });
    this.events.broadcast({ type: 'runUpdated', run: stored.run });
    this.track(launch(stored, headSha, model));
    return stored.run;
  }

  /** After a restart: reattach to runs that were still going, or fail the ones that never started. */
  public async resumeInterrupted(): Promise<void> {
    const interrupted = this.store.state.runs.filter((entry) => isActive(entry.run));
    for (const { run } of interrupted) {
      if (run.provider === 'claude') {
        await this.fail(
          run.id,
          'error',
          'The server restarted while Claude was reviewing, so the review was lost. Send it again.',
        );
        continue;
      }
      if (run.agentId && run.runId) {
        const apiKey = this.cursorApiKey();
        if (apiKey) {
          this.track(this.reattach(run.id, run.runId, run.agentId, apiKey));
        } else {
          await this.fail(
            run.id,
            'error',
            'The server restarted without a Cursor API key (Settings or CURSOR_API_KEY), so it cannot follow this agent run',
          );
        }
        continue;
      }
      await this.fail(run.id, 'error', 'The server restarted before the agent run started');
    }
  }

  /** Resolves once every background run this service is tracking has settled. */
  public async whenIdle(): Promise<void> {
    while (this.tasks.size > 0) {
      await Promise.all([...this.tasks]);
    }
  }

  /**
   * Reserves a finished run for posting so two requests cannot post it twice. Call `release` when
   * posting fails; `markPosted` releases it on success.
   */
  public claimForPosting(id: string): { stored: StoredRun; release: () => void } {
    const stored = this.requireRun(id);
    if (stored.run.status !== 'finished' || !stored.run.result) {
      throw new ApiError(409, 'conflict', 'Only a finished review with a result can be posted');
    }
    if (stored.run.disposition !== 'pending' || this.posting.has(id)) {
      throw new ApiError(
        409,
        'conflict',
        `This review was already ${stored.run.disposition === 'pending' ? 'being posted' : stored.run.disposition}`,
      );
    }
    this.posting.add(id);
    return { stored, release: () => this.posting.delete(id) };
  }

  public async markPosted(id: string, reviewUrl: string): Promise<ReviewRun> {
    try {
      return await this.patch(id, { disposition: 'posted', postedReviewUrl: reviewUrl });
    } finally {
      this.posting.delete(id);
    }
  }

  public async discard(id: string): Promise<ReviewRun> {
    const { run } = this.requireRun(id);
    if (isActive(run)) {
      throw new ApiError(409, 'conflict', 'Wait for the review to finish before discarding it');
    }
    if (run.disposition !== 'pending' || this.posting.has(id)) {
      throw new ApiError(409, 'conflict', `This review was already ${run.disposition}`);
    }
    return this.patch(id, { disposition: 'discarded' });
  }

  /** Checks the provider's key up front, so a missing one is refused before anything is queued. */
  private launcherFor(
    provider: ReviewProvider,
  ): (stored: StoredRun, headSha: string, model: string | undefined) => Promise<void> {
    if (provider === 'claude') {
      const claude = this.claude;
      if (!claude?.hasKey()) {
        throw new ApiError(
          400,
          'missingConfig',
          'Claude reviews need an Anthropic API key. Add it in Settings.',
          { provider },
        );
      }
      return (stored, headSha, model) => this.executeClaude(claude, stored, headSha, model);
    }
    const apiKey = this.cursorApiKey();
    if (!apiKey) {
      throw new ApiError(
        400,
        'missingConfig',
        'Cursor reviews need a Cursor API key. Add it in Settings.',
        { provider },
      );
    }
    return (stored, headSha, model) => this.execute(stored, headSha, apiKey, model);
  }

  private requireRun(id: string): StoredRun {
    const stored = this.get(id);
    if (!stored) {
      throw new ApiError(404, 'notFound', `No review run ${id}`);
    }
    return stored;
  }

  private track(task: Promise<void>): void {
    const tracked = task.catch((error: unknown) =>
      this.log(`review task failed: ${errorMessage(error)}`),
    );
    this.tasks.add(tracked);
    void tracked.finally(() => this.tasks.delete(tracked));
  }

  /**
   * Starts the agent on the head commit rather than the branch, so new pushes can't change what it
   * reviews, and its line numbers match the `commit_id` the findings are posted with. The base
   * repo URL plus the PR's `pull/<n>/head` ref (see the prompt) also covers PRs from forks.
   */
  private async execute(
    stored: StoredRun,
    headSha: string,
    apiKey: string,
    model: string | undefined,
  ): Promise<void> {
    const { id } = stored.run;
    const { quest } = stored;
    let agent: SDKAgent | undefined;
    let started = false;
    try {
      agent = await Agent.create({
        apiKey,
        name: `PR Quest review: ${quest.id}`,
        ...(model ? { model: { id: model } } : {}),
        cloud: {
          repos: [
            {
              url: `https://github.com/${quest.repo.owner}/${quest.repo.name}`,
              startingRef: headSha,
            },
          ],
          workOnCurrentBranch: false,
          autoCreatePR: false,
          skipReviewerRequest: true,
        },
      });
      this.log(`review ${id}: created agent ${agent.agentId} for ${quest.id} at ${headSha}`);
      await this.patch(id, { agentId: agent.agentId });

      const run = await agent.send(buildReviewPrompt(quest, headSha));
      started = true;
      this.log(`review ${id}: started run ${run.id} on agent ${agent.agentId}`);
      await this.patch(id, { runId: run.id, status: 'running' });

      await this.follow(id, run);
    } catch (error) {
      if (started) {
        await this.fail(id, 'error', errorMessage(error));
      } else {
        const retryable = error instanceof CursorAgentError ? error.isRetryable : undefined;
        await this.fail(id, 'startupFailed', errorMessage(error), retryable);
      }
    } finally {
      await agent?.[Symbol.asyncDispose]().catch((error: unknown) => {
        this.log(`review ${id}: failed to dispose agent: ${errorMessage(error)}`);
      });
    }
  }

  /** Claude reads the diff of the head commit, so its findings line up with the posted `commit_id`. */
  private async executeClaude(
    claude: ClaudeRunner,
    stored: StoredRun,
    headSha: string,
    model: string | undefined,
  ): Promise<void> {
    const { id } = stored.run;
    try {
      const result = await claude.review(stored.quest, headSha, model, {
        onRequest: async () => {
          await this.patch(id, { status: 'running' });
        },
      });
      await this.finish(id, result);
    } catch (error) {
      if (error instanceof ClaudeReviewError && error.stage === 'startup') {
        await this.fail(id, 'startupFailed', error.message, error.retryable);
      } else {
        await this.fail(id, 'error', errorMessage(error));
      }
    }
  }

  private async reattach(
    id: string,
    runId: string,
    agentId: string,
    apiKey: string,
  ): Promise<void> {
    try {
      const run = await Agent.getRun(runId, { runtime: 'cloud', agentId, apiKey });
      this.log(`review ${id}: reattached to run ${runId} on agent ${agentId}`);
      await this.follow(id, run);
    } catch (error) {
      await this.fail(
        id,
        'error',
        `Could not resume the agent run after a restart: ${errorMessage(error)}`,
      );
    }
  }

  private async follow(id: string, run: Run): Promise<void> {
    if (run.supports('stream')) {
      try {
        for await (const message of run.stream()) {
          if (message.type === 'status') {
            this.log(`review ${id}: run ${run.id} is ${message.status}`);
          }
        }
      } catch (error) {
        this.log(`review ${id}: status stream ended early: ${errorMessage(error)}`);
      }
    }
    await this.complete(id, await run.wait(), run.result);
  }

  private async complete(
    id: string,
    result: RunResult,
    fallbackText: string | undefined,
  ): Promise<void> {
    if (result.status !== 'finished') {
      const message =
        result.status === 'cancelled'
          ? 'The agent run was cancelled'
          : (result.error?.message ?? 'The agent run failed');
      await this.fail(id, 'error', message);
      return;
    }
    const parsed = parseReviewResult(result.result ?? fallbackText);
    if (!parsed.ok) {
      await this.fail(id, 'error', parsed.error);
      return;
    }
    const headSha = this.get(id)?.quest.headSha;
    const reported = parsed.reviewedSha;
    if (reported && headSha && !(reported.length >= 7 && headSha.startsWith(reported))) {
      await this.fail(
        id,
        'error',
        `The agent reviewed commit ${reported} instead of ${headSha}, so its line numbers may not match the PR. Send it again.`,
      );
      return;
    }
    await this.finish(id, parsed.result);
  }

  private async finish(id: string, result: ReviewResult): Promise<void> {
    await this.patch(id, { status: 'finished', finishedAt: this.now().toISOString(), result });
    this.log(`review ${id}: finished with ${result.findings.length} findings`);
    await this.game.recordAgentReviewFinished().catch((error: unknown) => {
      this.log(`review ${id}: could not count the agent review: ${errorMessage(error)}`);
    });
  }

  private async fail(
    id: string,
    status: 'error' | 'startupFailed',
    message: string,
    retryable?: boolean,
  ): Promise<void> {
    this.log(`review ${id}: ${status}: ${message}`);
    await this.patch(id, {
      status,
      finishedAt: this.now().toISOString(),
      error: retryable === undefined ? { message } : { message, retryable },
    });
  }

  private async patch(id: string, fields: Partial<ReviewRun>): Promise<ReviewRun> {
    let updated: ReviewRun | undefined;
    await this.store.update((state) => ({
      ...state,
      runs: state.runs.map((entry) => {
        if (entry.run.id !== id) {
          return entry;
        }
        updated = { ...entry.run, ...fields };
        return { ...entry, run: updated };
      }),
    }));
    if (!updated) {
      throw new ApiError(404, 'notFound', `No review run ${id}`);
    }
    this.events.broadcast({ type: 'runUpdated', run: updated });
    return updated;
  }
}

function snapshotOf(quest: Quest): QuestSnapshot {
  const snapshot: QuestSnapshot = {
    id: quest.id,
    title: quest.title,
    repo: quest.repo,
    number: quest.number,
    githubUrl: quest.githubUrl,
    sourceBranch: quest.sourceBranch,
    targetBranch: quest.targetBranch,
    difficulty: quest.difficulty,
    requestKind: quest.requestKind,
    requestedAt: quest.requestedAt,
  };
  if (quest.headSha) {
    snapshot.headSha = quest.headSha;
  }
  if (quest.linearUrl) {
    snapshot.linearUrl = quest.linearUrl;
  }
  return snapshot;
}
