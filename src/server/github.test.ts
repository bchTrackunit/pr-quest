import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';

import { GhError, type GhRunner } from './gh.ts';
import { GitHubClient, parsePullRequestDetails, parseSearchResults, toQuest } from './github.ts';
import type { ReviewDraft } from './reviewPayload.ts';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/gh/${name}`, import.meta.url), 'utf8');

const SEARCH_ALL = fixture('search-all.json');
const SEARCH_DIRECT = fixture('search-direct.json');
const VIEW_930 = fixture('pr-view-930.json');
const VIEW_24 = fixture('pr-view-24.json');

/** Answers each gh invocation from the fixtures, keyed by what the arguments ask for. */
function fixtureGh(
  overrides: { view24?: string | Error } = {},
): ReturnType<typeof vi.fn<GhRunner>> {
  return vi.fn<GhRunner>(async (args) => {
    if (args[0] === 'search') {
      return args.includes('user-review-requested:@me') ? SEARCH_DIRECT : SEARCH_ALL;
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

  test('searches open review requests with and without team requests', async () => {
    const gh = fixtureGh();

    await new GitHubClient(gh).fetchReviewRequests();

    expect(gh).toHaveBeenCalledWith(
      expect.arrayContaining(['search', 'prs', '--review-requested=@me', '--state=open']),
    );
    expect(gh).toHaveBeenCalledWith(
      expect.arrayContaining(['search', 'prs', 'user-review-requested:@me', '--state=open']),
    );
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

  test('skips a PR whose details fail and reports it', async () => {
    const onWarning = vi.fn();
    const client = new GitHubClient(
      fixtureGh({ view24: new GhError('gh: Not Found (HTTP 404)', 404) }),
      {
        onWarning,
      },
    );

    const data = await client.fetchReviewRequests();

    expect(data.map((entry) => entry.item.number)).toEqual([930]);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('Trackunit/state-of-code#24'));
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
