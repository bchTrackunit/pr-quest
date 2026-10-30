import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, CursorAgentError, type Run, type RunResult, type SDKAgent } from '@cursor/sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Quest, ReviewRun, ServerEvent } from '../shared/api.ts';
import { ReviewRunService, type ReviewRunServiceOptions } from './reviewRuns.ts';
import { StateStore, type StoredRun } from './store.ts';

vi.mock('@cursor/sdk', () => {
  class MockCursorAgentError extends Error {
    public readonly isRetryable: boolean;

    public constructor(message: string, options: { isRetryable?: boolean } = {}) {
      super(message);
      this.isRetryable = options.isRetryable ?? false;
    }
  }
  return { Agent: { create: vi.fn(), getRun: vi.fn() }, CursorAgentError: MockCursorAgentError };
});

const createMock = vi.mocked(Agent.create);
const getRunMock = vi.mocked(Agent.getRun);

const REVIEW_TEXT = [
  'Done.',
  '```json',
  JSON.stringify({
    summary: 'Small change.',
    verdict: 'comment',
    findings: [{ file: 'src/a.ts', line: 2, severity: 'minor', body: 'Name it better.' }],
  }),
  '```',
].join('\n');

function fakeRun(result: Partial<RunResult> = {}): Run {
  return {
    id: 'run-abc',
    agentId: 'bc-123',
    status: 'running',
    supports: () => true,
    stream: async function* () {
      yield { type: 'status', agent_id: 'bc-123', run_id: 'run-abc', status: 'RUNNING' };
    },
    wait: vi.fn(async () => ({
      id: 'run-abc',
      status: 'finished',
      result: REVIEW_TEXT,
      ...result,
    })),
  } as unknown as Run;
}

function fakeAgent(run: Run | Error = fakeRun()) {
  const agent = {
    agentId: 'bc-123',
    send: vi.fn(async () => {
      if (run instanceof Error) {
        throw run;
      }
      return run;
    }),
    [Symbol.asyncDispose]: vi.fn(async () => undefined),
  };
  createMock.mockResolvedValue(agent as unknown as SDKAgent);
  return agent;
}

const quest: Quest = {
  id: 'Trackunit/manager#7',
  title: 'Add cache',
  repo: { owner: 'Trackunit', name: 'manager' },
  number: 7,
  author: { name: 'a' },
  sourceBranch: 'feature/cache',
  targetBranch: 'master',
  headSha: 'abc',
  status: 'open',
  diffStats: { fileCount: 3, additions: 100, deletions: 5 },
  difficulty: 'Normal',
  requestKind: 'direct',
  requestedTeams: [],
  needsAttention: false,
  githubUrl: 'https://github.com/Trackunit/manager/pull/7',
  openedAt: '2026-10-30T08:00:00.000Z',
  updatedAt: '2026-10-30T08:00:00.000Z',
  requestedAt: '2026-10-30T08:00:00.000Z',
  source: 'github',
};

let dir: string;
let store: StateStore;
let events: Array<ServerEvent>;
let logs: Array<string>;
let recordAgentReviewFinished: ReturnType<typeof vi.fn<() => Promise<void>>>;
let idCounter: number;

function service(overrides: Partial<ReviewRunServiceOptions> = {}): ReviewRunService {
  return new ReviewRunService({
    store,
    events: { broadcast: (event) => events.push(event) },
    game: { recordAgentReviewFinished },
    apiKey: 'cursor-key',
    log: (message) => logs.push(message),
    now: () => new Date('2026-10-30T10:00:00.000Z'),
    newId: () => `review-${++idCounter}`,
    ...overrides,
  });
}

const runStatuses = (): Array<string> =>
  events.flatMap((event) => (event.type === 'runUpdated' ? [event.run.status] : []));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-runs-'));
  store = await StateStore.open(dir);
  events = [];
  logs = [];
  idCounter = 0;
  recordAgentReviewFinished = vi.fn(async () => undefined);
  createMock.mockReset();
  getRunMock.mockReset();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ReviewRunService.start', () => {
  test('returns a queued run immediately and persists it', async () => {
    fakeAgent();
    const runs = service();

    const run = await runs.start(quest);

    expect(run).toMatchObject({
      id: 'review-1',
      questId: quest.id,
      status: 'queued',
      disposition: 'pending',
    });
    expect(run.quest).toEqual({
      title: 'Add cache',
      repo: { owner: 'Trackunit', name: 'manager' },
      number: 7,
      githubUrl: 'https://github.com/Trackunit/manager/pull/7',
    });
    expect(store.state.runs[0]?.quest).toMatchObject({
      id: quest.id,
      headSha: 'abc',
      difficulty: 'Normal',
    });
    await runs.whenIdle();
  });

  test('creates a cloud agent on the PR branch that cannot open a PR', async () => {
    fakeAgent();
    const runs = service();

    await runs.start(quest);
    await runs.whenIdle();

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'cursor-key',
        cloud: {
          repos: [{ url: 'https://github.com/Trackunit/manager', startingRef: 'feature/cache' }],
          autoCreatePR: false,
          skipReviewerRequest: true,
        },
      }),
    );
    expect(createMock.mock.calls[0]?.[0]).not.toHaveProperty('model');
  });

  test('passes the requested model', async () => {
    fakeAgent();
    const runs = service();

    await runs.start(quest, { model: 'gpt-5' });
    await runs.whenIdle();

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ model: { id: 'gpt-5' } }));
  });

  test('finishes with the parsed result, logs ids and disposes the agent', async () => {
    const agent = fakeAgent();
    const runs = service();

    const { id } = await runs.start(quest);
    await runs.whenIdle();

    expect(runs.get(id)?.run).toMatchObject({
      status: 'finished',
      agentId: 'bc-123',
      runId: 'run-abc',
      finishedAt: '2026-10-30T10:00:00.000Z',
      result: { summary: 'Small change.', verdict: 'comment' },
    });
    expect(agent.send).toHaveBeenCalledWith(
      expect.stringContaining('git diff origin/master...HEAD'),
    );
    expect(agent[Symbol.asyncDispose]).toHaveBeenCalledOnce();
    expect(runStatuses()).toEqual(['queued', 'queued', 'running', 'finished']);
    expect(logs.join('\n')).toMatch(/bc-123[\s\S]*run-abc/);
    expect(recordAgentReviewFinished).toHaveBeenCalledOnce();
  });

  test('marks startupFailed with retryable when the SDK throws before the run starts', async () => {
    createMock.mockRejectedValue(
      new CursorAgentError('Repository not connected', { isRetryable: true }),
    );
    const runs = service();

    const { id } = await runs.start(quest);
    await runs.whenIdle();

    expect(runs.get(id)?.run).toMatchObject({
      status: 'startupFailed',
      error: { message: 'Repository not connected', retryable: true },
    });
    expect(recordAgentReviewFinished).not.toHaveBeenCalled();
  });

  test('marks startupFailed and disposes the agent when send fails', async () => {
    const agent = fakeAgent(new CursorAgentError('Rate limited', { isRetryable: false }));
    const runs = service();

    const { id } = await runs.start(quest);
    await runs.whenIdle();

    expect(runs.get(id)?.run).toMatchObject({
      status: 'startupFailed',
      error: { retryable: false },
    });
    expect(agent[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });

  test('marks error when the run itself fails', async () => {
    fakeAgent(
      fakeRun({ status: 'error', result: undefined, error: { message: 'Sandbox crashed' } }),
    );
    const runs = service();

    const { id } = await runs.start(quest);
    await runs.whenIdle();

    expect(runs.get(id)?.run).toMatchObject({
      status: 'error',
      error: { message: 'Sandbox crashed' },
    });
    expect(runs.get(id)?.run.error).not.toHaveProperty('retryable');
  });

  test('marks error when the agent output is not a review result', async () => {
    fakeAgent(fakeRun({ result: 'I could not find anything.' }));
    const runs = service();

    const { id } = await runs.start(quest);
    await runs.whenIdle();

    expect(runs.get(id)?.run).toMatchObject({
      status: 'error',
      error: { message: 'The agent did not return a JSON review result' },
    });
    expect(recordAgentReviewFinished).not.toHaveBeenCalled();
  });

  test('allows only one queued or running review per quest', async () => {
    fakeAgent();
    const runs = service();

    await runs.start(quest);
    await expect(runs.start(quest)).rejects.toMatchObject({ status: 409, code: 'conflict' });
    await runs.whenIdle();

    await expect(runs.start(quest)).resolves.toMatchObject({ status: 'queued' });
    await runs.whenIdle();
  });

  test('requires a Cursor API key', async () => {
    await expect(service({ apiKey: undefined }).start(quest)).rejects.toMatchObject({
      code: 'missingConfig',
    });
  });
});

describe('ReviewRunService.resumeInterrupted', () => {
  const stored = (run: Partial<ReviewRun>): StoredRun => ({
    run: {
      id: 'review-old',
      questId: quest.id,
      quest: {
        title: quest.title,
        repo: quest.repo,
        number: quest.number,
        githubUrl: quest.githubUrl,
      },
      status: 'running',
      disposition: 'pending',
      startedAt: '2026-10-30T09:00:00.000Z',
      ...run,
    },
    quest: { ...quest, headSha: 'abc' },
  });

  test('reattaches to a run that was still running', async () => {
    await store.update((state) => ({
      ...state,
      runs: [stored({ agentId: 'bc-9', runId: 'run-9' })],
    }));
    getRunMock.mockResolvedValue(fakeRun());
    const runs = service();

    await runs.resumeInterrupted();
    await runs.whenIdle();

    expect(getRunMock).toHaveBeenCalledWith('run-9', {
      runtime: 'cloud',
      agentId: 'bc-9',
      apiKey: 'cursor-key',
    });
    expect(runs.get('review-old')?.run.status).toBe('finished');
  });

  test('marks a run that never got a run id as failed', async () => {
    await store.update((state) => ({ ...state, runs: [stored({ status: 'queued' })] }));
    const runs = service();

    await runs.resumeInterrupted();
    await runs.whenIdle();

    expect(runs.get('review-old')?.run).toMatchObject({
      status: 'error',
      error: { message: expect.stringMatching(/restarted/) },
    });
    expect(getRunMock).not.toHaveBeenCalled();
  });

  test('marks the run failed when it cannot be reattached', async () => {
    await store.update((state) => ({
      ...state,
      runs: [stored({ agentId: 'bc-9', runId: 'run-9' })],
    }));
    getRunMock.mockRejectedValue(new Error('Agent not found'));
    const runs = service();

    await runs.resumeInterrupted();
    await runs.whenIdle();

    expect(runs.get('review-old')?.run).toMatchObject({
      status: 'error',
      error: { message: expect.stringContaining('Agent not found') },
    });
  });
});

describe('ReviewRunService dispositions', () => {
  test('discards a finished run and rejects discarding a running one', async () => {
    fakeAgent();
    const runs = service();
    const { id } = await runs.start(quest);

    await expect(runs.discard(id)).rejects.toMatchObject({ status: 409 });
    await runs.whenIdle();

    await expect(runs.discard(id)).resolves.toMatchObject({ disposition: 'discarded' });
  });

  test('records the posted review URL', async () => {
    fakeAgent();
    const runs = service();
    const { id } = await runs.start(quest);
    await runs.whenIdle();

    const run = await runs.markPosted(id, 'https://github.com/x#pullrequestreview-1');

    expect(run).toMatchObject({
      disposition: 'posted',
      postedReviewUrl: 'https://github.com/x#pullrequestreview-1',
    });
  });

  test('activeRunIdFor returns the newest run still awaiting a decision', async () => {
    fakeAgent();
    const runs = service();
    const first = await runs.start(quest);
    await runs.whenIdle();
    await runs.discard(first.id);
    const second = await runs.start(quest);
    await runs.whenIdle();

    expect(runs.activeRunIdFor(quest.id)).toBe(second.id);
    expect(runs.list().map((run) => run.id)).toEqual([second.id, first.id]);
  });
});
