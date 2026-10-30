import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';

import { GhError, type GhRunner } from './gh.ts';
import {
  buildPullRequestBatchQuery,
  DETAILS_BATCH_SIZE,
  GitHubClient,
  parsePullRequestBatch,
  parsePullRequestDetails,
  parseSearchResults,
  toQuest,
} from './github.ts';
import type { ReviewDraft } from './reviewPayload.ts';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/gh/${name}`, import.meta.url), 'utf8');

const SEARCH_ALL = fixture('search-all.json');
const SEARCH_DIRECT = fixture('search-direct.json');
const VIEW_930 = fixture('pr-view-930.json');
const VIEW_24 = fixture('pr-view-24.json');
const BATCH = fixture('graphql-batch.json');
const BATCH_PARTIAL = fixture('graphql-batch-partial.json');

const isBatch = (args: Array<string>): boolean => args[0] === 'api' && args[1] === 'graphql';

/** Answers each gh invocation from the fixtures, keyed by what the arguments ask for. */
function fixtureGh(
  overrides: { batch?: string | Error; view24?: string | Error } = {},
): ReturnType<typeof vi.fn<GhRunner>> {
  return vi.fn<GhRunner>(async (args) => {
    if (args[0] === 'search') {
      return args.includes('user-review-requested:@me') ? SEARCH_DIRECT : SEARCH_ALL;
    }
    if (isBatch(args)) {
      const batch = overrides.batch ?? BATCH;
      if (batch instanceof Error) {
        throw batch;
      }
      return batch;
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const view24 = overrides.view24 ?? VIEW_24;
      if (args[2] === '24') {
        if (view24 instanceof Error) {
          throw view24;
        }
        return view24;
      }
      return VIEW_930;
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  });
}

describe('parseSearchResults', () => {
  test('reads number, repo and timestamps from gh search output', () => {
    const [first] = parseSearchResults(SEARCH_ALL);

    expect(first).toEqual({
      number: 930,
      title: 'chore(builds): register indoor-tracking-api with the API_V3 CI generator',
      url: 'https://github.com/Trackunit/circleci-configuration/pull/930',
      repo: { owner: 'Trackunit', name: 'circleci-configuration' },
      authorLogin: 'kfr-example',
      createdAt: '2026-10-30T13:30:09Z',
      updatedAt: '2026-10-30T13:45:04Z',
      isDraft: false,
    });
  });

  test('rejects output that is not a search result list', () => {
    expect(() => parseSearchResults('{"message":"rate limited"}')).toThrow(
      /Unexpected gh search output/,
    );
  });
});

describe('parsePullRequestDetails', () => {
  test('reads branches, diff stats and review requests', () => {
    expect(parsePullRequestDetails(VIEW_24)).toMatchObject({
      headRefName: 'kpr/quarterly-report',
      baseRefName: 'main',
      headRefOid: '0123456789abcdef0123456789abcdef01234567',
      additions: 1800,
      deletions: 150,
      changedFiles: 12,
      authorName: 'Kieran Example',
      requestedTeams: ['team-gluon'],
    });
  });

  test('rejects malformed output', () => {
    expect(() => parsePullRequestDetails('not json')).toThrow(/Unexpected gh pr view output/);
  });
});

describe('toQuest', () => {
  test('maps a team request without Linear data', () => {
    const item = parseSearchResults(SEARCH_ALL).at(0);
    if (!item) {
      throw new Error('fixture is empty');
    }

    const quest = toQuest({ item, details: parsePullRequestDetails(VIEW_930), direct: false });

    expect(quest).toEqual({
      id: 'Trackunit/circleci-configuration#930',
      title: 'chore(builds): register indoor-tracking-api with the API_V3 CI generator',
      repo: { owner: 'Trackunit', name: 'circleci-configuration' },
      number: 930,
      author: { name: 'kfr-example', githubLogin: 'kfr-example' },
      sourceBranch: 'kfr-example/ins-2967-register-ci',
      targetBranch: 'master',
      headSha: 'd77c66a89e0707ccc917203251d3a3a1efce4182',
      status: 'open',
      diffStats: { fileCount: 1, additions: 1, deletions: 0 },
      difficulty: 'Trivial',
      requestKind: 'team',
      requestedTeams: ['team-gluon'],
      needsAttention: false,
      githubUrl: 'https://github.com/Trackunit/circleci-configuration/pull/930',
      openedAt: '2026-10-30T13:30:09Z',
      updatedAt: '2026-10-30T13:45:04Z',
      requestedAt: '2026-10-30T13:30:09Z',
      source: 'github',
    });
  });

  test('maps a direct draft request enriched by Linear', () => {
    const item = parseSearchResults(SEARCH_ALL).at(1);
    if (!item) {
      throw new Error('fixture is missing the second item');
    }

    const quest = toQuest({
      item,
      details: parsePullRequestDetails(VIEW_24),
      direct: true,
      linear: { appUrl: 'https://linear.app/trackunit/review/x-1', needsAttention: true },
    });

    expect(quest).toMatchObject({
      requestKind: 'direct',
      requestedTeams: [],
      status: 'draft',
      difficulty: 'Hard',
      needsAttention: true,
      linearUrl: 'https://linear.app/trackunit/review/x-1',
      source: 'linear',
      author: { name: 'Kieran Example', githubLogin: 'kpr-example' },
    });
  });
});

describe('GitHubClient.fetchReviewRequests', () => {
  test('marks PRs found by the direct-only search as direct', async () => {
    const client = new GitHubClient(fixtureGh());

    const data = await client.fetchReviewRequests();

    expect(data.map((entry) => [entry.item.number, entry.direct])).toEqual([
      [930, false],
      [24, true],
    ]);
  });

  test('searches open review requests, then reads every PR in one GraphQL query', async () => {
    const gh = fixtureGh();

    await new GitHubClient(gh).fetchReviewRequests();

    expect(gh).toHaveBeenCalledWith(
      expect.arrayContaining(['search', 'prs', '--review-requested=@me', '--state=open']),
    );
    expect(gh).toHaveBeenCalledWith(
      expect.arrayContaining(['search', 'prs', 'user-review-requested:@me', '--state=open']),
    );
    const batchCalls = gh.mock.calls.filter(([args]) => isBatch(args));
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]?.[0]).toEqual(['api', 'graphql', '--input', '-']);
    expect(JSON.parse(batchCalls[0]?.[1]?.input ?? '{}')).toMatchObject({
      variables: {
        owner0: 'Trackunit',
        name0: 'circleci-configuration',
        number0: 930,
        owner1: 'Trackunit',
        name1: 'state-of-code',
        number1: 24,
      },
    });
    expect(gh.mock.calls.some(([args]) => args[0] === 'pr')).toBe(false);
  });

  test('reads branches, diff stats and team requests from the batch', async () => {
    const data = await new GitHubClient(fixtureGh()).fetchReviewRequests();

    expect(data.map((entry) => entry.details)).toEqual([
      parsePullRequestDetails(VIEW_930),
      parsePullRequestDetails(VIEW_24),
    ]);
  });

  test('keeps the rest of a batch when GitHub cannot resolve one PR', async () => {
    const onWarning = vi.fn();
    const partialFailure = new GhError(
      'gh: Could not resolve to a PullRequest with the number of 24.',
      undefined,
      BATCH_PARTIAL,
    );
    const gh = fixtureGh({ batch: partialFailure });

    const data = await new GitHubClient(gh, { onWarning }).fetchReviewRequests();

    expect(data.map((entry) => entry.item.number)).toEqual([930]);
    expect(onWarning).toHaveBeenCalledWith(
      'Skipping Trackunit/state-of-code#24: Could not resolve to a PullRequest with the number of 24.',
    );
    expect(gh.mock.calls.some(([args]) => args[0] === 'pr')).toBe(false);
  });

  test('falls back to one gh pr view per PR when the whole batch fails', async () => {
    const onWarning = vi.fn();
    const gh = fixtureGh({ batch: new GhError('gh: Bad Gateway (HTTP 502)', 502) });

    const data = await new GitHubClient(gh, { onWarning }).fetchReviewRequests();

    expect(data.map((entry) => entry.item.number)).toEqual([930, 24]);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('falling back'));
    expect(gh).toHaveBeenCalledWith([
      'pr',
      'view',
      '24',
      '-R',
      'Trackunit/state-of-code',
      '--json',
      expect.any(String),
    ]);
  });

  test('skips a PR whose fallback view fails and reports it', async () => {
    const onWarning = vi.fn();
    const client = new GitHubClient(
      fixtureGh({
        batch: new GhError('gh: Bad Gateway (HTTP 502)', 502),
        view24: new GhError('gh: Not Found (HTTP 404)', 404),
      }),
      { onWarning },
    );

    const data = await client.fetchReviewRequests();

    expect(data.map((entry) => entry.item.number)).toEqual([930]);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('Trackunit/state-of-code#24'));
  });

  test(`splits the queue into queries of ${DETAILS_BATCH_SIZE} PRs`, async () => {
    const count = DETAILS_BATCH_SIZE + 5;
    const search = Array.from({ length: count }, (_, index) => ({
      number: index + 1,
      title: `PR ${index + 1}`,
      url: `https://github.com/o/r/pull/${index + 1}`,
      repository: { nameWithOwner: 'o/r' },
      author: { login: 'a' },
      createdAt: '2026-10-30T10:00:00Z',
      updatedAt: '2026-10-30T10:00:00Z',
      isDraft: false,
    }));
    const batch: { data: Record<string, unknown> } = JSON.parse(BATCH);
    const [, onePullRequest] = Object.values(batch.data);
    const gh = vi.fn<GhRunner>(async (args, options) => {
      if (args[0] === 'search') {
        return args.includes('user-review-requested:@me') ? '[]' : JSON.stringify(search);
      }
      const { variables }: { variables: Record<string, unknown> } = JSON.parse(
        options?.input ?? '{}',
      );
      const size = Object.keys(variables).length / 3;
      const data = Object.fromEntries(
        Array.from({ length: size }, (_, index) => [`pr${index}`, onePullRequest]),
      );
      return JSON.stringify({ data });
    });

    const quests = await new GitHubClient(gh).fetchReviewRequests();

    expect(quests).toHaveLength(count);
    const batchSizes = gh.mock.calls
      .filter(([args]) => isBatch(args))
      .map(([, options]) => Object.keys(JSON.parse(options?.input ?? '{}').variables).length / 3);
    expect(batchSizes.sort((a, b) => b - a)).toEqual([DETAILS_BATCH_SIZE, 5]);
  });
});

describe('buildPullRequestBatchQuery', () => {
  test('aliases one lookup per PR and passes owner, name and number as variables', () => {
    const { query, variables } = buildPullRequestBatchQuery([
      { repo: { owner: 'o', name: 'r' }, number: 5 },
      { repo: { owner: 'x', name: 'y"}' }, number: 9 },
    ]);

    expect(variables).toEqual({
      owner0: 'o',
      name0: 'r',
      number0: 5,
      owner1: 'x',
      name1: 'y"}',
      number1: 9,
    });
    expect(query).toContain(
      'pr1: repository(owner: $owner1, name: $name1) { pullRequest(number: $number1) { ...Details } }',
    );
    expect(query).not.toContain('y"}');
  });
});

describe('parsePullRequestBatch', () => {
  test('throws when the response carries no data at all', () => {
    expect(() =>
      parsePullRequestBatch('{"errors":[{"message":"API rate limit exceeded"}]}', 1),
    ).toThrow(/API rate limit exceeded/);
  });

  test('reports a missing alias without a matching error as not found', () => {
    expect(parsePullRequestBatch('{"data":{}}', 1)).toEqual([
      { error: 'GitHub returned no pull request' },
    ]);
  });
});

describe('GitHubClient.approve', () => {
  test('approves through gh pr review with the body on stdin', async () => {
    const gh = vi.fn<GhRunner>().mockResolvedValue('');

    await new GitHubClient(gh).approve({ repo: { owner: 'o', name: 'r' }, number: 5 }, 'LGTM');

    expect(gh).toHaveBeenCalledWith(
      ['pr', 'review', '5', '-R', 'o/r', '--approve', '--body-file', '-'],
      {
        input: 'LGTM',
      },
    );
  });

  test('approves without a body', async () => {
    const gh = vi.fn<GhRunner>().mockResolvedValue('');

    await new GitHubClient(gh).approve({ repo: { owner: 'o', name: 'r' }, number: 5 });

    expect(gh).toHaveBeenCalledWith(['pr', 'review', '5', '-R', 'o/r', '--approve']);
  });
});

describe('GitHubClient.submitReview', () => {
  const ref = { repo: { owner: 'o', name: 'r' }, number: 5 };
  const draft: ReviewDraft = {
    event: 'comment',
    summary: 'Looks fine.',
    verdict: 'comment',
    commitId: 'abc123',
    findings: [
      { file: 'src/a.ts', line: 3, severity: 'major', body: 'Null check missing.' },
      { file: 'src/b.ts', severity: 'nit', body: 'Rename this file.' },
    ],
  };

  const postedPayloads = (gh: ReturnType<typeof vi.fn<GhRunner>>): Array<unknown> =>
    gh.mock.calls.map(([, options]) => JSON.parse(options?.input ?? 'null'));

  test('posts one review with inline comments and returns its URL', async () => {
    const gh = vi
      .fn<GhRunner>()
      .mockResolvedValue('{"html_url":"https://github.com/o/r/pull/5#pullrequestreview-1"}');

    const result = await new GitHubClient(gh).submitReview(ref, draft);

    expect(result).toEqual({
      url: 'https://github.com/o/r/pull/5#pullrequestreview-1',
      inlineCommentsDropped: false,
    });
    expect(gh).toHaveBeenCalledWith(
      ['api', '-X', 'POST', 'repos/o/r/pulls/5/reviews', '--input', '-'],
      {
        input: expect.any(String),
      },
    );
    expect(postedPayloads(gh)[0]).toMatchObject({
      event: 'COMMENT',
      commit_id: 'abc123',
      comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT' }],
    });
  });

  test('retries with every finding in the body when GitHub rejects the lines', async () => {
    const gh = vi
      .fn<GhRunner>()
      .mockRejectedValueOnce(new GhError('gh: Validation Failed (HTTP 422)', 422))
      .mockResolvedValueOnce('{"html_url":"https://github.com/o/r/pull/5#pullrequestreview-2"}');

    const result = await new GitHubClient(gh).submitReview(ref, draft);

    expect(result.inlineCommentsDropped).toBe(true);
    const retry = postedPayloads(gh)[1] as {
      comments: Array<unknown>;
      body: string;
      commit_id?: string;
    };
    expect(retry.comments).toEqual([]);
    expect(retry.commit_id).toBeUndefined();
    expect(retry.body).toContain('`src/a.ts:3`');
  });

  test('does not retry other failures', async () => {
    const gh = vi.fn<GhRunner>().mockRejectedValue(new GhError('gh: Forbidden (HTTP 403)', 403));

    await expect(new GitHubClient(gh).submitReview(ref, draft)).rejects.toThrow('HTTP 403');
    expect(gh).toHaveBeenCalledTimes(1);
  });
});
