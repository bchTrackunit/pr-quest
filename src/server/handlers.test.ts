import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type Run, type SDKAgent } from '@cursor/sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ReviewRun } from '../shared/api.ts';
import { EventHub } from './events.ts';
import { GameService } from './game.ts';
import { GhError } from './gh.ts';
import {
  parsePullRequestDetails,
  parseSearchResults,
  type GitHubClient,
  type ReviewRequestData,
} from './github.ts';
import { createHandlers, type AppServices } from './handlers.ts';
import { LinearReviewClient } from './linear.ts';
import { QuestService } from './questService.ts';
import { ReviewRunService } from './reviewRuns.ts';
import { createRouter } from './router.ts';
import { StateStore } from './store.ts';

vi.mock('@cursor/sdk', () => ({
  Agent: { create: vi.fn(), getRun: vi.fn() },
  CursorAgentError: class extends Error {},
}));

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/gh/${name}`, import.meta.url), 'utf8');

const searchItems = parseSearchResults(fixture('search-all.json'));
const teamItem = searchItems.at(0);
const directItem = searchItems.at(1);
if (!teamItem || !directItem) {
  throw new Error('search fixture needs two items');
}
const REQUESTS: Array<ReviewRequestData> = [
  { item: teamItem, details: parsePullRequestDetails(fixture('pr-view-930.json')), direct: false },
  { item: directItem, details: parsePullRequestDetails(fixture('pr-view-24.json')), direct: true },
];

const DIRECT_ID = 'Trackunit/state-of-code#24';
const DIRECT_PATH = encodeURIComponent(DIRECT_ID);

const REVIEW_TEXT = `\`\`\`json\n${JSON.stringify({
  summary: 'Two issues.',
  verdict: 'requestChanges',
  findings: [
    { file: 'src/a.ts', line: 3, severity: 'major', body: 'Bug.' },
    { file: 'src/b.ts', severity: 'nit', body: 'Style.' },
  ],
})}\n\`\`\``;

let dir: string;
let server: Server | undefined;
let port: number;
let services: AppServices;
let github: {
  fetchReviewRequests: ReturnType<typeof vi.fn<GitHubClient['fetchReviewRequests']>>;
  fetchRateLimitReset: ReturnType<typeof vi.fn<GitHubClient['fetchRateLimitReset']>>;
  approve: ReturnType<typeof vi.fn<GitHubClient['approve']>>;
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
  const game = new GameService(store, events);
  github = {
    fetchReviewRequests: vi.fn(async () => REQUESTS),
    fetchRateLimitReset: vi.fn(async () => undefined),
    approve: vi.fn(async () => undefined),
    submitReview: vi.fn(async () => ({
      url: 'https://github.com/r#pullrequestreview-9',
      inlineCommentsDropped: false,
    })),
  };
  const runs = new ReviewRunService({ store, events, game, apiKey: 'key', log: () => undefined });
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

  test('reports gh failures as upstreamFailed', async () => {
    github.fetchReviewRequests.mockRejectedValue(
      new GhError('gh: Bad credentials (HTTP 401)', 401),
    );

    const response = await send('GET', '/api/quests');

    expect(response).toEqual({
      status: 502,
      body: { error: { code: 'upstreamFailed', message: 'gh: Bad credentials (HTTP 401)' } },
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
      new GhError('gh: You have exceeded a secondary rate limit (HTTP 403)', 403),
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
      new GhError('HTTP 403: API rate limit exceeded for user ID 1.', 403),
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
    const response = await send('POST', `/api/quests/${DIRECT_PATH}/approve`, { confirm: false });

    expect(response.status).toBe(400);
    expect(github.approve).not.toHaveBeenCalled();
  });

  test('rejects malformed quest ids', async () => {
    const response = await send('POST', `/api/quests/${encodeURIComponent('-R/x#1')}/approve`, {
      confirm: true,
    });

    expect(response.status).toBe(400);
  });

  test('responds 404 for a PR that is not in the queue', async () => {
    const response = await send('POST', `/api/quests/${encodeURIComponent('o/r#5')}/approve`, {
      confirm: true,
    });

    expect(response.status).toBe(404);
  });

  test('approves through gh, awards XP and drops the quest from the board', async () => {
    const response = await send('POST', `/api/quests/${DIRECT_PATH}/approve`, {
      confirm: true,
      body: 'LGTM',
    });

    expect(response.status).toBe(200);
    expect(github.approve).toHaveBeenCalledWith(
      { repo: { owner: 'Trackunit', name: 'state-of-code' }, number: 24 },
      'LGTM',
    );
    expect(response.body).toMatchObject({
      questId: DIRECT_ID,
      approvedVia: 'github',
      outcome: { xpGained: 30 + 10, unlocked: [{ id: 'first-blood' }] },
    });
    const quests = (await send('GET', '/api/quests')).body as { quests: Array<{ id: string }> };
    expect(quests.quests.map((quest) => quest.id)).not.toContain(DIRECT_ID);
  });

  test('awards nothing when gh fails', async () => {
    github.approve.mockRejectedValue(new GhError('gh: Forbidden (HTTP 403)', 403));

    const response = await send('POST', `/api/quests/${DIRECT_PATH}/approve`, { confirm: true });

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

  test('posting sends the selected findings as one review and awards XP', async () => {
    const run = await finishedRun();

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
        commitId: '0123456789abcdef0123456789abcdef01234567',
        findings: [{ file: 'src/b.ts', severity: 'nit', body: 'Style.' }],
      },
    );
    expect(response.body).toMatchObject({
      reviewUrl: 'https://github.com/r#pullrequestreview-9',
      run: { disposition: 'posted', postedReviewUrl: 'https://github.com/r#pullrequestreview-9' },
      outcome: { xpGained: 30 + 10 },
    });
  });

  test('posting twice is a conflict', async () => {
    const run = await finishedRun();
    await send('POST', `/api/runs/${run.id}/post`, {});

    const second = await send('POST', `/api/runs/${run.id}/post`, {});

    expect(second.status).toBe(409);
    expect(github.submitReview).toHaveBeenCalledTimes(1);
  });

  test('rejects finding indexes that do not exist', async () => {
    const run = await finishedRun();

    const response = await send('POST', `/api/runs/${run.id}/post`, { findingIndexes: [2] });

    expect(response.status).toBe(400);
    expect((await send('POST', `/api/runs/${run.id}/post`, {})).status).toBe(200);
  });

  test('a failed post can be retried', async () => {
    const run = await finishedRun();
    github.submitReview.mockRejectedValueOnce(new GhError('gh: Server Error (HTTP 500)', 500));

    expect((await send('POST', `/api/runs/${run.id}/post`, {})).status).toBe(502);
    expect((await send('POST', `/api/runs/${run.id}/post`, {})).status).toBe(200);
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
    expect(achievements.achievements).toHaveLength(7);
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
