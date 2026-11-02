import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type Run, type SDKAgent } from '@cursor/sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ReviewRun } from '@pr-quest/contract/api';
import { EventHub } from '../platform/events.ts';
import { GameService, StateStore } from '../features/game/index.ts';
import { GitHubApiError, NotSignedInError } from '../platform/githubApi.ts';
import {
  type GitHubClient,
  type ReviewRequestData,
  LinearReviewClient,
  QuestService,
} from '../features/quests/index.ts';
import { createHandlers, type AppServices } from './handlers.ts';
import { ReviewRunService } from '../features/reviews/index.ts';
import { createRouter } from '../platform/router.ts';
import { reviewRequests } from '../features/quests/test-utils/fixtures.ts';

vi.mock('@cursor/sdk', () => ({
  Agent: { create: vi.fn(), getRun: vi.fn() },
  CursorAgentError: class extends Error {},
}));

const REQUESTS: Array<ReviewRequestData> = reviewRequests();

const DIRECT_ID = 'Trackunit/state-of-code#24';
const DIRECT_PATH = encodeURIComponent(DIRECT_ID);
const DIRECT_HEAD = '0123456789abcdef0123456789abcdef01234567';
const NEWER_HEAD = 'fedcba9876543210fedcba9876543210fedcba98';

const REVIEW_TEXT = `\`\`\`json\n${JSON.stringify({
  summary: 'Two issues.',
  verdict: 'requestChanges',
  findings: [
    { file: 'src/a.ts', line: 3, severity: 'major', body: 'Bug.' },
    { file: 'src/b.ts', severity: 'nit', body: 'Style.' },
  ],
  reviewedSha: DIRECT_HEAD,
})}\n\`\`\``;

let dir: string;
let server: Server | undefined;
let port: number;
let services: AppServices;
let github: {
  fetchReviewRequests: ReturnType<typeof vi.fn<GitHubClient['fetchReviewRequests']>>;
  fetchRateLimitReset: ReturnType<typeof vi.fn<GitHubClient['fetchRateLimitReset']>>;
  approve: ReturnType<typeof vi.fn<GitHubClient['approve']>>;
  fetchHeadSha: ReturnType<typeof vi.fn<GitHubClient['fetchHeadSha']>>;
  submitReview: ReturnType<typeof vi.fn<GitHubClient['submitReview']>>;
};

interface TestResponse {
  status: number;
  body: unknown;
}

function send(method: string, path: string, body?: unknown): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function mockAgentFinishing(text = REVIEW_TEXT): void {
  const run = {
    id: 'run-1',
    agentId: 'bc-1',
    supports: () => false,
    wait: async () => ({ id: 'run-1', status: 'finished', result: text }),
  } as unknown as Run;
  vi.mocked(Agent.create).mockResolvedValue({
    agentId: 'bc-1',
    send: async () => run,
    [Symbol.asyncDispose]: async () => undefined,
  } as unknown as SDKAgent);
}

function select(
  runId: string,
  findingIndexes: Array<number>,
  selected = true,
): Promise<TestResponse> {
  return send('PUT', `/api/runs/${runId}/selection`, { findingIndexes, selected });
}

async function finishedRun(): Promise<ReviewRun> {
  mockAgentFinishing();
  const started = await send('POST', `/api/quests/${DIRECT_PATH}/review`, {});
  await services.runs.whenIdle();
  return (started.body as { run: ReviewRun }).run;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-handlers-'));
  const store = await StateStore.open(dir);
  const events = new EventHub();
  // A Friday afternoon, two days after the oldest fixture PR opened: no time-based unlocks.
  const game = new GameService(store, events, { now: () => new Date(2026, 9, 30, 15) });
  github = {
    fetchReviewRequests: vi.fn(async () => REQUESTS),
    fetchRateLimitReset: vi.fn(async () => undefined),
    approve: vi.fn(async () => undefined),
    fetchHeadSha: vi.fn(async () => DIRECT_HEAD),
    submitReview: vi.fn(async () => ({
      url: 'https://github.com/r#pullrequestreview-9',
      inlineCommentsDropped: false,
    })),
  };
  const runs = new ReviewRunService({
    store,
    events,
    game,
    cursorApiKey: () => 'key',
    log: () => undefined,
  });
  const linear = new LinearReviewClient();
  const quests = new QuestService({
    github,
    linear,
    events,
    game,
    activeRunIdFor: (questId) => runs.activeRunIdFor(questId),
    log: () => undefined,
  });
  services = { quests, runs, game, github, events };

  server = createServer(
    createRouter(
      createHandlers({ host: '127.0.0.1', port: 0, uiPort: 0, stateDir: dir }, services),
    ),
  );
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});

afterEach(async () => {
  services.events.close();
  await services.runs.whenIdle();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe('GET /api/quests', () => {
  test('lists quests from GitHub', async () => {
    const response = await send('GET', '/api/quests');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      source: 'github',
      quests: [{ id: DIRECT_ID, requestKind: 'direct' }, { requestKind: 'team' }],
    });
  });

  test('asks the player to sign in when there is no GitHub token', async () => {
    github.fetchReviewRequests.mockRejectedValue(new NotSignedInError());

    const response = await send('GET', '/api/quests');

    expect(response).toMatchObject({ status: 401, body: { error: { code: 'notSignedIn' } } });
  });

  test('reports GitHub failures as upstreamFailed', async () => {
    github.fetchReviewRequests.mockRejectedValue(
      new GitHubApiError('Server Error (HTTP 500)', { httpStatus: 500 }),
    );

    const response = await send('GET', '/api/quests');

    expect(response).toEqual({
      status: 502,
      body: { error: { code: 'upstreamFailed', message: 'Server Error (HTTP 500)' } },
    });
  });

  test('asks the player to sign in again when GitHub rejects the token', async () => {
    github.fetchReviewRequests.mockRejectedValue(
      new GitHubApiError('Bad credentials (HTTP 401)', { httpStatus: 401 }),
    );

    const response = await send('GET', '/api/quests');

    expect(response).toMatchObject({
      status: 401,
      body: { error: { code: 'notSignedIn', message: expect.stringMatching(/rejected/) } },
    });
  });

  test('refresh=1 bypasses the cache', async () => {
    await send('GET', '/api/quests');

    await send('GET', '/api/quests?refresh=1');

    expect(github.fetchReviewRequests).toHaveBeenCalledTimes(2);
  });

  test('answers a rate-limited refresh with the cached quests and the limit', async () => {
    await send('GET', '/api/quests');
    github.fetchReviewRequests.mockRejectedValue(
      new GitHubApiError('You have exceeded a secondary rate limit (HTTP 403)', {
        httpStatus: 403,
      }),
    );

    const response = await send('GET', '/api/quests?refresh=1');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      stale: true,
      rateLimit: { kind: 'secondary', limitedUntil: expect.any(String) },
      quests: [{ id: DIRECT_ID }, { requestKind: 'team' }],
    });
  });

  test('reports a rate limit with nothing cached as rateLimited', async () => {
    github.fetchReviewRequests.mockRejectedValue(
      new GitHubApiError('HTTP 403: API rate limit exceeded for user ID 1.', { httpStatus: 403 }),
    );

    const response = await send('GET', '/api/quests');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: { code: 'rateLimited', message: expect.stringContaining('rate limit') },
    });
  });
});

describe('POST /api/quests/:id/approve', () => {
  test('requires explicit confirmation', async () => {
    const response = await send('POST', `/api/quests/${DIRECT_PATH}/approve`, {
      confirm: false,
      headSha: DIRECT_HEAD,
    });

    expect(response.status).toBe(400);
    expect(github.approve).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', undefined],
    ['not a commit SHA', 'main'],
  ])('rejects a head commit that is %s', async (_label, headSha) => {
    const response = await send('POST', `/api/quests/${DIRECT_PATH}/approve`, {
      confirm: true,
      headSha,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { message: expect.stringContaining('headSha') } });
    expect(github.approve).not.toHaveBeenCalled();
  });

  test('rejects malformed quest ids', async () => {
    const response = await send('POST', `/api/quests/${encodeURIComponent('-R/x#1')}/approve`, {
      confirm: true,
      headSha: DIRECT_HEAD,
    });

    expect(response.status).toBe(400);
  });

  test('responds 404 for a PR that is not in the queue', async () => {
    const response = await send('POST', `/api/quests/${encodeURIComponent('o/r#5')}/approve`, {
      confirm: true,
      headSha: DIRECT_HEAD,
    });

    expect(response.status).toBe(404);
  });

  test('refuses with headChanged when new commits were pushed, and updates the quest', async () => {
    await send('GET', '/api/quests');
    github.fetchHeadSha.mockResolvedValue(NEWER_HEAD);

    const response = await send('POST', `/api/quests/${DIRECT_PATH}/approve`, {
      confirm: true,
      headSha: DIRECT_HEAD,
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: { code: 'headChanged', message: expect.stringContaining('fedcba9') },
    });
    expect(github.approve).not.toHaveBeenCalled();
    expect(services.game.player().xp).toBe(0);
    expect(services.quests.find(DIRECT_ID)?.headSha).toBe(NEWER_HEAD);
    expect(github.fetchReviewRequests).toHaveBeenCalledTimes(1);
  });

  test('approves the commit the player saw, awards XP and drops the quest from the board', async () => {
    const response = await send('POST', `/api/quests/${DIRECT_PATH}/approve`, {
      confirm: true,
      headSha: DIRECT_HEAD.toUpperCase(),
      body: 'LGTM',
    });

    expect(response.status).toBe(200);
    expect(github.fetchHeadSha).toHaveBeenCalledWith({
      repo: { owner: 'Trackunit', name: 'state-of-code' },
      number: 24,
    });
    expect(github.approve).toHaveBeenCalledWith(
      { repo: { owner: 'Trackunit', name: 'state-of-code' }, number: 24 },
      { commitId: DIRECT_HEAD, body: 'LGTM' },
    );
    expect(response.body).toMatchObject({
      questId: DIRECT_ID,
      approvedVia: 'github',
      outcome: {
        xpGained: 30 + 25 + 50,
        unlocked: [{ id: 'first-blood' }, { id: 'archaeologist' }],
        achievements: [{ name: 'First Blood' }, { name: 'Archaeologist' }],
      },
    });
    const quests = (await send('GET', '/api/quests')).body as { quests: Array<{ id: string }> };
    expect(quests.quests.map((quest) => quest.id)).not.toContain(DIRECT_ID);
  });

  test("records the quest's repo and author for the achievements", async () => {
    await send('POST', `/api/quests/${DIRECT_PATH}/approve`, {
      confirm: true,
      headSha: DIRECT_HEAD,
    });

    const progress = (id: string) =>
      services.game.achievements().find((status) => status.id === id)?.progress;
    expect(progress('explorer')).toBe(1);
    expect(progress('diplomat')).toBe(1);
  });

  test('approving a newer quest while an older one waits is no Archaeologist', async () => {
    const TEAM_ID = 'Trackunit/circleci-configuration#930';
    await send('GET', '/api/quests');
    const headSha = services.quests.find(TEAM_ID)?.headSha ?? '';
    github.fetchHeadSha.mockResolvedValue(headSha);

    const response = await send('POST', `/api/quests/${encodeURIComponent(TEAM_ID)}/approve`, {
      confirm: true,
      headSha,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      outcome: {
        unlocked: expect.arrayContaining([expect.objectContaining({ id: 'first-blood' })]),
      },
    });
    expect(response.body).not.toMatchObject({
      outcome: {
        unlocked: expect.arrayContaining([expect.objectContaining({ id: 'archaeologist' })]),
      },
    });
  });

  test('awards nothing when gh fails', async () => {
    github.approve.mockRejectedValue(
      new GitHubApiError('Forbidden (HTTP 403)', { httpStatus: 403 }),
    );

    const response = await send('POST', `/api/quests/${DIRECT_PATH}/approve`, {
      confirm: true,
      headSha: DIRECT_HEAD,
    });

    expect(response.status).toBe(502);
    expect(services.game.player().xp).toBe(0);
  });
});

describe('POST /api/quests/:id/review', () => {
  test('starts a queued review run', async () => {
    mockAgentFinishing();

    const response = await send('POST', `/api/quests/${DIRECT_PATH}/review`, {});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ run: { questId: DIRECT_ID, status: 'queued' } });
  });

  test('rejects an invalid model', async () => {
    const response = await send('POST', `/api/quests/${DIRECT_PATH}/review`, { model: 42 });

    expect(response.status).toBe(400);
  });
});

describe('runs', () => {
  test('GET /api/runs/:id returns the run and 404s for unknown ids', async () => {
    const run = await finishedRun();

    expect((await send('GET', `/api/runs/${run.id}`)).body).toMatchObject({
      run: { id: run.id, status: 'finished' },
    });
    expect((await send('GET', '/api/runs/nope')).status).toBe(404);
    expect((await send('GET', '/api/runs')).body).toMatchObject({ runs: [{ id: run.id }] });
  });

  test('posting sends only the selected findings as one review and awards XP', async () => {
    const run = await finishedRun();
    await select(run.id, [1]);

    const response = await send('POST', `/api/runs/${run.id}/post`, {
      event: 'requestChanges',
      findingIndexes: [1],
    });

    expect(response.status).toBe(200);
    expect(github.submitReview).toHaveBeenCalledWith(
      { repo: { owner: 'Trackunit', name: 'state-of-code' }, number: 24 },
      {
        event: 'requestChanges',
        summary: 'Two issues.',
        verdict: 'requestChanges',
        provider: 'cursor',
        commitId: '0123456789abcdef0123456789abcdef01234567',
        findings: [{ file: 'src/b.ts', severity: 'nit', body: 'Style.' }],
      },
    );
    expect(response.body).toMatchObject({
      reviewUrl: 'https://github.com/r#pullrequestreview-9',
      run: {
        disposition: 'posted',
        postedReviewUrl: 'https://github.com/r#pullrequestreview-9',
        selectedFindings: [1],
      },
      outcome: {
        xpGained: 30 + 25 + 50,
        unlocked: [{ id: 'first-blood' }, { id: 'archaeologist' }],
      },
    });
    const gatekeeper = services.game.achievements().find((status) => status.id === 'gatekeeper');
    expect(gatekeeper?.progress).toBe(1);
  });

  test('Eagle Eye counts only the findings that were posted', async () => {
    const majorLeftOut = await finishedRun();
    const majorSelected = await finishedRun();
    await select(majorLeftOut.id, [1]);
    await send('POST', `/api/runs/${majorLeftOut.id}/post`, { findingIndexes: [1] });
    const eagleEye = () =>
      services.game.achievements().find((status) => status.id === 'eagle-eye')?.unlockedAt;
    expect(eagleEye()).toBeUndefined();

    await select(majorSelected.id, [0, 1]);
    const response = await send('POST', `/api/runs/${majorSelected.id}/post`, {
      findingIndexes: [0, 1],
    });

    expect(response.body).toMatchObject({ outcome: { unlocked: [{ id: 'eagle-eye' }] } });
    expect(eagleEye()).toBeDefined();
  });

  test('hands the posted findings, and only those, to the game', async () => {
    const recordReviewAction = vi.spyOn(services.game, 'recordReviewAction');
    const run = await finishedRun();
    await select(run.id, [0]);

    await send('POST', `/api/runs/${run.id}/post`, { findingIndexes: [0] });

    expect(recordReviewAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'reviewPosted',
        postedSeverities: ['major'],
      }),
    );
  });

  test.each([
    ['never selected', false],
    ['selected and cleared again', true],
  ])('never posts a finding that was %s', async (_label, wasSelected) => {
    const run = await finishedRun();
    if (wasSelected) {
      await select(run.id, [0]);
      await select(run.id, [0], false);
    }

    const response = await send('POST', `/api/runs/${run.id}/post`, { findingIndexes: [0] });

    expect(response).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } });
    expect(github.submitReview).not.toHaveBeenCalled();
    expect(services.runs.get(run.id)?.run.disposition).toBe('pending');
    expect(services.game.player().xp).toBe(0);
  });

  test('refuses to post when the confirmed findings leave out a selected one', async () => {
    const run = await finishedRun();
    await select(run.id, [0, 1]);

    const response = await send('POST', `/api/runs/${run.id}/post`, { findingIndexes: [1] });

    expect(response.status).toBe(409);
    expect(github.submitReview).not.toHaveBeenCalled();
    expect(
      (await send('POST', `/api/runs/${run.id}/post`, { findingIndexes: [1, 0] })).status,
    ).toBe(200);
  });

  test('refuses a post that does not say which findings to post', async () => {
    const run = await finishedRun();
    await select(run.id, [0, 1]);

    const response = await send('POST', `/api/runs/${run.id}/post`, { event: 'comment' });

    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: 'badRequest', message: expect.stringContaining('findingIndexes') } },
    });
    expect(github.submitReview).not.toHaveBeenCalled();
  });

  test('with nothing selected, posts the summary alone and still awards the same XP', async () => {
    const run = await finishedRun();

    const response = await send('POST', `/api/runs/${run.id}/post`, { findingIndexes: [] });

    expect(response).toMatchObject({ status: 200, body: { outcome: { xpGained: 40 + 25 + 50 } } });
    expect(github.submitReview.mock.calls[0]?.[1]).toMatchObject({
      summary: 'Two issues.',
      findings: [],
    });
  });

  test('selecting findings earns no XP', async () => {
    const run = await finishedRun();

    await select(run.id, [0, 1]);
    await select(run.id, [0], false);

    expect(services.game.player().xp).toBe(0);
  });

  test('an agent verdict of approve still posts a comment, never an approval', async () => {
    mockAgentFinishing(
      `\`\`\`json\n${JSON.stringify({ summary: 'Fine.', verdict: 'approve', findings: [], reviewedSha: DIRECT_HEAD })}\n\`\`\``,
    );
    const started = await send('POST', `/api/quests/${DIRECT_PATH}/review`, {});
    await services.runs.whenIdle();
    const { run } = started.body as { run: ReviewRun };

    expect(
      (await send('POST', `/api/runs/${run.id}/post`, { event: 'approve', findingIndexes: [] }))
        .status,
    ).toBe(400);
    expect((await send('POST', `/api/runs/${run.id}/post`, { findingIndexes: [] })).status).toBe(
      200,
    );

    expect(github.submitReview).toHaveBeenCalledTimes(1);
    expect(github.submitReview.mock.calls[0]?.[1]).toMatchObject({
      event: 'comment',
      verdict: 'approve',
    });
    expect(github.approve).not.toHaveBeenCalled();
  });

  test('posts to the PR named by the run quest id, not a repo read back from state', async () => {
    const run = await finishedRun();
    const stored = services.runs.get(run.id);
    if (!stored) {
      throw new Error('run missing');
    }
    stored.quest.repo = { owner: 'someone-else', name: 'other-repo' };

    await send('POST', `/api/runs/${run.id}/post`, { findingIndexes: [] });

    expect(github.submitReview.mock.calls[0]?.[0]).toEqual({
      repo: { owner: 'Trackunit', name: 'state-of-code' },
      number: 24,
    });
  });

  test('names the provider and model and lists the omitted files in the posted draft', async () => {
    const run = await finishedRun();
    const stored = services.runs.get(run.id);
    if (!stored?.run.result) {
      throw new Error('run missing');
    }
    stored.run.provider = 'claude';
    stored.run.model = 'claude-opus-5-5';
    stored.run.result.omitted = [{ file: 'yarn.lock', reason: 'lockfile' }];

    await send('POST', `/api/runs/${run.id}/post`, { findingIndexes: [] });

    expect(github.submitReview.mock.calls[0]?.[1]).toMatchObject({
      provider: 'claude',
      model: 'claude-opus-5-5',
      omitted: [{ file: 'yarn.lock', reason: 'lockfile' }],
    });
  });

  test('posting twice is a conflict', async () => {
    const run = await finishedRun();
    await send('POST', `/api/runs/${run.id}/post`, { findingIndexes: [] });

    const second = await send('POST', `/api/runs/${run.id}/post`, { findingIndexes: [] });

    expect(second.status).toBe(409);
    expect(github.submitReview).toHaveBeenCalledTimes(1);
  });

  test('rejects finding indexes that do not exist', async () => {
    const run = await finishedRun();
    await select(run.id, [0, 1]);

    const response = await send('POST', `/api/runs/${run.id}/post`, { findingIndexes: [0, 1, 2] });

    expect(response).toMatchObject({
      status: 400,
      body: { error: { message: expect.stringContaining('2') } },
    });
    expect(github.submitReview).not.toHaveBeenCalled();
    expect(
      (await send('POST', `/api/runs/${run.id}/post`, { findingIndexes: [0, 1] })).status,
    ).toBe(200);
  });

  test('a failed post can be retried', async () => {
    const run = await finishedRun();
    github.submitReview.mockRejectedValueOnce(
      new GitHubApiError('Server Error (HTTP 500)', { httpStatus: 500 }),
    );

    expect((await send('POST', `/api/runs/${run.id}/post`, { findingIndexes: [] })).status).toBe(
      502,
    );
    expect((await send('POST', `/api/runs/${run.id}/post`, { findingIndexes: [] })).status).toBe(
      200,
    );
  });

  test('PUT /api/runs/:id/selection saves the selection and returns the run', async () => {
    const run = await finishedRun();

    const response = await select(run.id, [0, 1]);
    const cleared = await select(run.id, [1], false);

    expect(response).toMatchObject({
      status: 200,
      body: { run: { id: run.id, selectedFindings: [0, 1] } },
    });
    expect(cleared.body).toMatchObject({ run: { selectedFindings: [0] } });
    expect((await send('GET', `/api/runs/${run.id}`)).body).toMatchObject({
      run: { selectedFindings: [0] },
    });
  });

  test.each([
    ['a selection that is not a boolean', { findingIndexes: [0], selected: 'yes' }],
    ['a missing selection', { findingIndexes: [0] }],
    ['no findings', { findingIndexes: [], selected: true }],
    ['a negative id', { findingIndexes: [-1], selected: true }],
    ['a fractional id', { findingIndexes: [0.5], selected: true }],
    ['a finding the result does not have', { findingIndexes: [2], selected: true }],
    ['no body', undefined],
  ])('PUT /api/runs/:id/selection refuses %s', async (_label, body) => {
    const run = await finishedRun();

    const response = await send('PUT', `/api/runs/${run.id}/selection`, body);

    expect(response).toMatchObject({ status: 400, body: { error: { code: 'badRequest' } } });
    expect(services.runs.get(run.id)?.run.selectedFindings).toBeUndefined();
  });

  test('PUT /api/runs/:id/selection 404s for unknown runs and 409s once posted', async () => {
    const run = await finishedRun();
    await send('POST', `/api/runs/${run.id}/post`, { findingIndexes: [] });

    expect((await select('nope', [0])).status).toBe(404);
    expect((await select(run.id, [0])).status).toBe(409);
  });

  test('discarding marks the run discarded', async () => {
    const run = await finishedRun();

    const response = await send('POST', `/api/runs/${run.id}/discard`);

    expect(response.body).toMatchObject({ run: { disposition: 'discarded' } });
  });
});

describe('player', () => {
  test('GET /api/player and /api/achievements expose the game state', async () => {
    expect((await send('GET', '/api/player')).body).toMatchObject({
      player: { xp: 0, level: 1, xpForNextLevel: 100 },
    });
    const achievements = (await send('GET', '/api/achievements')).body as {
      achievements: Array<{ id: string }>;
    };
    expect(achievements.achievements).toHaveLength(27);
  });
});

describe('GET /api/events', () => {
  test('streams the current quests to a new client', async () => {
    await send('GET', '/api/quests');

    const firstChunk = await new Promise<{ type: string; chunk: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
          if (text.includes('data:')) {
            resolve({ type: String(res.headers['content-type']), chunk: text });
            req.destroy();
          }
        });
      });
      req.on('error', reject);
      req.end();
    });

    expect(firstChunk.type).toBe('text/event-stream');
    expect(firstChunk.chunk).toContain('"type":"questsUpdated"');
  });
});

describe('without services', () => {
  test('only health is implemented', () => {
    expect(
      Object.keys(createHandlers({ host: '127.0.0.1', port: 0, uiPort: 0, stateDir: dir })),
    ).toEqual(['health']);
  });
});
