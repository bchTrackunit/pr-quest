import { describe, expect, test, vi } from 'vitest';

import {
  buildPullRequestBatchQuery,
  DETAILS_BATCH_SIZE,
  GitHubClient,
  IncompleteQuestListError,
  parsePullRequestBatch,
  parseSearchResults,
  toQuest,
} from './github.ts';
import { GitHubApi, GitHubApiError, type FetchLike } from './githubApi.ts';
import type { ReviewDraft } from './reviewPayload.ts';
import { fixture, reviewRequests } from './test-utils/fixtures.ts';

const SEARCH_ALL = fixture('search-all.json');
const SEARCH_DIRECT = fixture('search-direct.json');
const BATCH = fixture('graphql-batch.json');
const BATCH_PARTIAL = fixture('graphql-batch-partial.json');
const RATE_LIMIT = fixture('rate-limit.json');
const [TEAM, DIRECT] = reviewRequests();
if (!TEAM || !DIRECT) {
  throw new Error('fixtures need two review requests');
}

type Reply = { status: number; body: string; headers?: Record<string, string> };

const ok = (body: string): Reply => ({ status: 200, body });
const json = (value: unknown, status = 200): Reply => ({ status, body: JSON.stringify(value) });

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  accept: string;
}

/** A fake GitHub API: `route` answers each call, which is recorded in `calls`. */
function fakeGitHub(route: (call: Call) => Reply | undefined) {
  const calls: Array<Call> = [];
  const fetchMock = vi.fn<FetchLike>(async (url, init) => {
    const parsed = new URL(url);
    const headers = new Headers(init.headers);
    const call: Call = {
      method: init.method ?? 'GET',
      path: parsed.pathname,
      query: parsed.searchParams,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      accept: headers.get('accept') ?? '',
    };
    calls.push(call);
    const reply = route(call);
    if (!reply) {
      throw new Error(`unexpected GitHub call: ${call.method} ${call.path}`);
    }
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  });
  const client = (onWarning?: (message: string) => void) =>
    new GitHubClient(new GitHubApi({ token: async () => 'gho_test', fetch: fetchMock }), {
      onWarning,
    });
  return { calls, client };
}

const isBatch = (call: Call): boolean => call.path === '/graphql';
const batchSize = (call: Call): number =>
  Object.keys((call.body as { variables: object }).variables).length / 3;

/** The default answers: both searches, the batch, `/user` and `/rate_limit`. */
function fixtureRoute(
  overrides: { search?: Reply; batch?: (call: Call) => Reply } = {},
): (call: Call) => Reply | undefined {
  return (call) => {
    if (call.path === '/search/issues') {
      return (
        overrides.search ??
        ok(call.query.get('q')?.includes('user-review-requested:@me') ? SEARCH_DIRECT : SEARCH_ALL)
      );
    }
    if (isBatch(call)) {
      return overrides.batch ? overrides.batch(call) : ok(BATCH);
    }
    if (call.path === '/user') {
      return json({ login: 'player-login', avatar_url: 'https://avatars/x' });
    }
    if (call.path === '/rate_limit') {
      return ok(RATE_LIMIT);
    }
    return undefined;
  };
}

const searchLimited: Reply = {
  status: 403,
  body: JSON.stringify({ message: 'API rate limit exceeded for user ID 1.' }),
  headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1793368860' },
};

const badGateway: Reply = { status: 502, body: '{"message":"Bad Gateway"}' };

/** Answers single-PR fallback queries from the batch fixture, by PR number. */
function singleFromBatch(call: Call, failNumber?: number, failure: Reply = badGateway): Reply {
  const { variables } = call.body as { variables: Record<string, unknown> };
  if (Object.keys(variables).length > 3) {
    return badGateway;
  }
  if (variables.number0 === failNumber) {
    return failure;
  }
  const data = JSON.parse(BATCH).data;
  const pullRequest = variables.number0 === 930 ? data.pr0 : data.pr1;
  return json({ data: { viewer: data.viewer, pr0: pullRequest } });
}

describe('parseSearchResults', () => {
  test('reads number, repo and timestamps from the search API', () => {
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

  test('skips items whose repository URL it cannot read', () => {
    const value = JSON.parse(SEARCH_ALL);
    value.items[0].repository_url = 'https://example.com/elsewhere';

    expect(parseSearchResults(JSON.stringify(value)).map((item) => item.number)).toEqual([24]);
  });

  test('rejects output that is not a search result', () => {
    expect(() => parseSearchResults('[]')).toThrow(/Unexpected GitHub search response/);
  });
});

describe('toQuest', () => {
  test('maps a team request without Linear data', () => {
    expect(toQuest(TEAM)).toEqual({
      id: 'Trackunit/circleci-configuration#930',
      title: 'chore(builds): register indoor-tracking-api with the API_V3 CI generator',
      repo: { owner: 'Trackunit', name: 'circleci-configuration' },
      number: 930,
      author: { name: 'kfr-example', githubLogin: 'kfr-example' },
      sourceBranch: 'kfr-example/ins-2967-register-ci',
      targetBranch: 'master',
      headSha: 'd77c66a89e0707ccc917203251d3a3a1efce4182',
      status: 'open',
      isDraft: false,
      approvedByOthers: false,
      approvalCount: 0,
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
    const quest = toQuest({
      ...DIRECT,
      viewerLogin: 'player-login',
      linear: { appUrl: 'https://linear.app/trackunit/review/x-1', needsAttention: true },
    });

    expect(quest).toMatchObject({
      requestKind: 'direct',
      requestedTeams: [],
      status: 'draft',
      isDraft: true,
      approvedByOthers: true,
      approvalCount: 1,
      difficulty: 'Hard',
      needsAttention: true,
      linearUrl: 'https://linear.app/trackunit/review/x-1',
      source: 'linear',
      author: { name: 'Kieran Example', githubLogin: 'kpr-example' },
    });
  });

  test("ignores the player's own approval whatever its letter case", () => {
    const details = { ...DIRECT.details, approvedBy: ['Player-Login'] };

    expect(toQuest({ ...DIRECT, details, viewerLogin: 'player-login' })).toMatchObject({
      approvedByOthers: false,
      approvalCount: 0,
    });
  });
});

describe('GitHubClient.fetchReviewRequests', () => {
  test('marks PRs found by the direct-only search as direct', async () => {
    const data = await fakeGitHub(fixtureRoute()).client().fetchReviewRequests();

    expect(data.map((entry) => [entry.item.number, entry.direct])).toEqual([
      [930, false],
      [24, true],
    ]);
  });

  test('searches open review requests, then reads every PR in one GraphQL query', async () => {
    const github = fakeGitHub(fixtureRoute());

    await github.client().fetchReviewRequests();

    const queries = github.calls
      .filter((call) => call.path === '/search/issues')
      .map((call) => [call.query.get('q'), call.query.get('per_page')]);
    expect(queries).toEqual([
      ['is:pr is:open review-requested:@me', '100'],
      ['is:pr is:open user-review-requested:@me', '100'],
    ]);
    const batches = github.calls.filter(isBatch);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.body).toMatchObject({
      variables: {
        owner0: 'Trackunit',
        name0: 'circleci-configuration',
        number0: 930,
        owner1: 'Trackunit',
        name1: 'state-of-code',
        number1: 24,
      },
    });
  });

  test('reads branches, diff stats and team requests from the batch', async () => {
    const data = await fakeGitHub(fixtureRoute()).client().fetchReviewRequests();

    expect(data.map((entry) => entry.details)).toEqual([TEAM.details, DIRECT.details]);
  });

  test("asks the batch for drafts, latest reviews and the player's login", async () => {
    const github = fakeGitHub(fixtureRoute());

    const data = await github.client().fetchReviewRequests();

    const { query } = github.calls.find(isBatch)?.body as { query: string };
    expect(query).toContain('viewer { login }');
    expect(query).toContain('isDraft');
    expect(query).toContain('latestReviews(first: 100) { nodes { state author { login } } }');
    expect(data.map((entry) => entry.viewerLogin)).toEqual(['player-login', 'player-login']);
    expect(github.calls.some((call) => call.path === '/user')).toBe(false);
  });

  test('rejects a rate-limited search with its reset time and makes no further calls', async () => {
    const github = fakeGitHub(fixtureRoute({ search: searchLimited }));

    const error = await github
      .client()
      .fetchReviewRequests()
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      message: expect.stringContaining('API rate limit exceeded'),
      rateLimit: { kind: 'primary', resetAt: new Date(1793368860 * 1000) },
    });
    expect(github.calls.some(isBatch)).toBe(false);
  });

  test('does not fall back to single-PR queries when the batch is rate limited', async () => {
    const onWarning = vi.fn();
    const limited = json({
      errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' }],
    });
    const github = fakeGitHub(fixtureRoute({ batch: () => limited }));

    await expect(github.client(onWarning).fetchReviewRequests()).rejects.toThrow(
      'API rate limit exceeded',
    );
    expect(github.calls.filter(isBatch)).toHaveLength(1);
    expect(onWarning).not.toHaveBeenCalled();
  });

  test('stops the per-PR fallback at the first rate-limited query', async () => {
    const secondary: Reply = {
      status: 403,
      body: '{"message":"You have exceeded a secondary rate limit."}',
    };
    const github = fakeGitHub(
      fixtureRoute({ batch: (call) => singleFromBatch(call, 24, secondary) }),
    );

    await expect(github.client().fetchReviewRequests()).rejects.toThrow('secondary rate limit');
  });

  test('keeps the rest of a batch when GitHub cannot resolve one PR', async () => {
    const onWarning = vi.fn();
    const github = fakeGitHub(fixtureRoute({ batch: () => ok(BATCH_PARTIAL) }));

    const data = await github.client(onWarning).fetchReviewRequests();

    expect(data.map((entry) => entry.item.number)).toEqual([930]);
    expect(onWarning).toHaveBeenCalledWith(
      'Skipping Trackunit/state-of-code#24: Could not resolve to a PullRequest with the number of 24.',
    );
    expect(github.calls.filter(isBatch)).toHaveLength(1);
  });

  test('falls back to one query per PR when the whole batch fails', async () => {
    const onWarning = vi.fn();
    const github = fakeGitHub(fixtureRoute({ batch: (call) => singleFromBatch(call) }));

    const data = await github.client(onWarning).fetchReviewRequests();

    expect(data.map((entry) => entry.item.number)).toEqual([930, 24]);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('falling back'));
    expect(github.calls.filter(isBatch).map(batchSize)).toEqual([2, 1, 1]);
  });

  test('reads the login from /user when every batch fell back', async () => {
    const withoutViewer = (call: Call): Reply => {
      const reply = singleFromBatch(call);
      const value = JSON.parse(reply.body);
      delete value.data?.viewer;
      return json(value, reply.status);
    };
    const github = fakeGitHub(fixtureRoute({ batch: withoutViewer }));

    const data = await github.client(vi.fn()).fetchReviewRequests();

    expect(github.calls.filter((call) => call.path === '/user')).toHaveLength(1);
    expect(data.at(1)?.viewerLogin).toBe('player-login');
  });

  test('skips a PR whose fallback query fails and reports it', async () => {
    const onWarning = vi.fn();
    const github = fakeGitHub(fixtureRoute({ batch: (call) => singleFromBatch(call, 24) }));

    const data = await github.client(onWarning).fetchReviewRequests();

    expect(data.map((entry) => entry.item.number)).toEqual([930]);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('Trackunit/state-of-code#24'));
  });

  test('fails instead of returning an empty queue when every PR lookup fails', async () => {
    const github = fakeGitHub(fixtureRoute({ batch: () => badGateway }));

    const result = github.client(vi.fn()).fetchReviewRequests();

    await expect(result).rejects.toBeInstanceOf(IncompleteQuestListError);
    await expect(result).rejects.toThrow('Could not read 2 of 2 review requests');
  });

  test('returns an empty queue when the search finds nothing', async () => {
    const empty = json({ total_count: 0, incomplete_results: false, items: [] });
    const github = fakeGitHub(fixtureRoute({ search: empty }));

    await expect(github.client().fetchReviewRequests()).resolves.toEqual([]);
    expect(github.calls.some(isBatch)).toBe(false);
  });

  test(`splits the queue into queries of ${DETAILS_BATCH_SIZE} PRs`, async () => {
    const count = DETAILS_BATCH_SIZE + 5;
    const items = Array.from({ length: count }, (_, index) => ({
      number: index + 1,
      title: `PR ${index + 1}`,
      html_url: `https://github.com/o/r/pull/${index + 1}`,
      repository_url: 'https://api.github.com/repos/o/r',
      user: { login: 'a' },
      created_at: '2026-10-30T10:00:00Z',
      updated_at: '2026-10-30T10:00:00Z',
    }));
    const onePullRequest = JSON.parse(BATCH).data.pr0;
    const github = fakeGitHub(
      fixtureRoute({
        search: json({ total_count: count, incomplete_results: false, items }),
        batch: (call) =>
          json({
            data: Object.fromEntries(
              Array.from({ length: batchSize(call) }, (_, index) => [`pr${index}`, onePullRequest]),
            ),
          }),
      }),
    );

    const quests = await github.client().fetchReviewRequests();

    expect(quests).toHaveLength(count);
    expect(
      github.calls
        .filter(isBatch)
        .map(batchSize)
        .sort((a, b) => b - a),
    ).toEqual([DETAILS_BATCH_SIZE, 5]);
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
    expect(parsePullRequestBatch('{"data":{}}', 1)).toEqual({
      entries: [{ error: 'GitHub returned no pull request' }],
    });
  });

  test("returns the player's login next to the entries", () => {
    expect(parsePullRequestBatch(BATCH, 2).viewerLogin).toBe('player-login');
  });
});

describe('GitHubClient.fetchRateLimitReset', () => {
  test('reads the exhausted quota reset from /rate_limit', async () => {
    const github = fakeGitHub(fixtureRoute());

    await expect(github.client().fetchRateLimitReset()).resolves.toEqual(
      new Date('2026-10-30T14:01:00.000Z'),
    );
    expect(github.calls.map((call) => call.path)).toEqual(['/rate_limit']);
  });

  test('returns undefined and warns when the call fails', async () => {
    const onWarning = vi.fn();
    const github = fakeGitHub(() => badGateway);

    await expect(github.client(onWarning).fetchRateLimitReset()).resolves.toBeUndefined();
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('Bad Gateway'));
  });
});

describe('GitHubClient.fetchViewer', () => {
  test("reads the player's login, name and avatar from /user", async () => {
    const github = fakeGitHub(() =>
      json({ login: 'Player', name: 'Pat Player', avatar_url: 'https://avatars/p' }),
    );

    await expect(github.client().fetchViewer()).resolves.toEqual({
      login: 'Player',
      name: 'Pat Player',
      avatarUrl: 'https://avatars/p',
    });
  });
});

describe('GitHubClient.approve', () => {
  const ref = { repo: { owner: 'o', name: 'r' }, number: 5 };
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const created = json({ html_url: 'https://github.com/o/r/pull/5#pullrequestreview-3' });

  test('approves the given commit through the reviews API', async () => {
    const github = fakeGitHub(() => created);

    await github.client().approve(ref, { commitId: sha, body: 'LGTM "ship it"' });

    expect(github.calls).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/repos/o/r/pulls/5/reviews',
        body: { event: 'APPROVE', commit_id: sha, body: 'LGTM "ship it"' },
      }),
    ]);
  });

  test('approves without a body', async () => {
    const github = fakeGitHub(() => created);

    await github.client().approve(ref, { commitId: sha });

    expect(github.calls[0]?.body).toEqual({ event: 'APPROVE', commit_id: sha });
  });

  test('encodes owner and repo names in the path', async () => {
    const github = fakeGitHub(() => created);

    await github
      .client()
      .approve({ repo: { owner: 'o', name: 'r/../x' }, number: 5 }, { commitId: sha });

    expect(github.calls[0]?.path).toBe('/repos/o/r%2F..%2Fx/pulls/5/reviews');
  });
});

describe('GitHubClient.fetchHeadSha', () => {
  test("reads the PR's current head commit", async () => {
    const github = fakeGitHub(() => json({ head: { sha: 'ABCDEF0123' } }));

    const head = await github.client().fetchHeadSha({ repo: { owner: 'o', name: 'r' }, number: 5 });

    expect(head).toBe('abcdef0123');
    expect(github.calls[0]).toMatchObject({ method: 'GET', path: '/repos/o/r/pulls/5' });
  });

  test('rejects a response without a head commit', async () => {
    const github = fakeGitHub(() => json({}));

    await expect(
      github.client().fetchHeadSha({ repo: { owner: 'o', name: 'r' }, number: 5 }),
    ).rejects.toThrow(GitHubApiError);
  });
});

describe('GitHubClient.fetchDiff', () => {
  const ref = { repo: { owner: 'o', name: 'r' }, number: 5 };
  const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
  const DIFF = 'diff --git a/a.ts b/a.ts\n';

  test('compares the target branch with the pinned head commit', async () => {
    const github = fakeGitHub(() => ok(DIFF));

    const diff = await github.client().fetchDiff(ref, { base: 'release/1.0', headSha: HEAD });

    expect(diff).toBe(DIFF);
    expect(github.calls).toHaveLength(1);
    expect(github.calls[0]).toMatchObject({
      method: 'GET',
      path: `/repos/o/r/compare/release/1.0...${HEAD}`,
      accept: 'application/vnd.github.diff',
    });
  });

  test("falls back to the PR's diff while the head is still the pinned commit", async () => {
    const github = fakeGitHub((call) => {
      if (call.path.includes('/compare/')) {
        return json({ message: 'Not Found' }, 404);
      }
      return call.accept === 'application/vnd.github.diff' ? ok(DIFF) : json({ head: { sha: HEAD } });
    });

    const diff = await github.client().fetchDiff(ref, { base: 'main', headSha: HEAD });

    expect(diff).toBe(DIFF);
    expect(github.calls.map((call) => [call.path, call.accept])).toEqual([
      [`/repos/o/r/compare/main...${HEAD}`, 'application/vnd.github.diff'],
      ['/repos/o/r/pulls/5', 'application/vnd.github.diff'],
      ['/repos/o/r/pulls/5', 'application/vnd.github+json'],
    ]);
  });

  test('refuses the fallback diff once the PR has moved on', async () => {
    const github = fakeGitHub((call) => {
      if (call.path.includes('/compare/')) {
        return json({ message: 'Not Found' }, 404);
      }
      return call.accept === 'application/vnd.github.diff'
        ? ok(DIFF)
        : json({ head: { sha: '1111111111111111111111111111111111111111' } });
    });

    await expect(github.client().fetchDiff(ref, { base: 'main', headSha: HEAD })).rejects.toThrow(
      /moved on to 1111111/,
    );
  });

  test('does not fall back when GitHub is rate limiting', async () => {
    const github = fakeGitHub(() => ({
      status: 403,
      body: JSON.stringify({ message: 'API rate limit exceeded' }),
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1798632000' },
    }));

    await expect(
      github.client().fetchDiff(ref, { base: 'main', headSha: HEAD }),
    ).rejects.toMatchObject({ rateLimit: { kind: 'primary' } });
    expect(github.calls).toHaveLength(1);
  });
});

describe('GitHubClient.submitReview', () => {
  const ref = { repo: { owner: 'o', name: 'r' }, number: 5 };
  const draft: ReviewDraft = {
    event: 'comment',
    summary: 'Looks fine.',
    verdict: 'comment',
    provider: 'cursor',
    commitId: 'abc123',
    findings: [
      { file: 'src/a.ts', line: 3, severity: 'major', body: 'Null check missing.' },
      { file: 'src/b.ts', severity: 'nit', body: 'Rename this file.' },
    ],
  };

  test('posts one review with inline comments and returns its URL', async () => {
    const github = fakeGitHub(() =>
      json({ html_url: 'https://github.com/o/r/pull/5#pullrequestreview-1' }),
    );

    const result = await github.client().submitReview(ref, draft);

    expect(result).toEqual({
      url: 'https://github.com/o/r/pull/5#pullrequestreview-1',
      inlineCommentsDropped: false,
    });
    expect(github.calls[0]).toMatchObject({
      method: 'POST',
      path: '/repos/o/r/pulls/5/reviews',
      body: {
        event: 'COMMENT',
        commit_id: 'abc123',
        comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT' }],
      },
    });
  });

  test('retries with every finding in the body when GitHub rejects the lines', async () => {
    const replies = [
      json({ message: 'Validation Failed' }, 422),
      json({ html_url: 'https://github.com/o/r/pull/5#pullrequestreview-2' }),
    ];
    const github = fakeGitHub(() => replies.shift());

    const result = await github.client().submitReview(ref, draft);

    expect(result.inlineCommentsDropped).toBe(true);
    const retry = github.calls[1]?.body as {
      comments: Array<unknown>;
      body: string;
      commit_id?: string;
    };
    expect(retry.comments).toEqual([]);
    expect(retry.commit_id).toBeUndefined();
    expect(retry.body).toContain('`src/a.ts:3`');
  });

  test('does not retry other failures', async () => {
    const github = fakeGitHub(() => json({ message: 'Forbidden' }, 403));

    await expect(github.client().submitReview(ref, draft)).rejects.toThrow('HTTP 403');
    expect(github.calls).toHaveLength(1);
  });
});
