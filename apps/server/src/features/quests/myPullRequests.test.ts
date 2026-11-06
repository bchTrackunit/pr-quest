import { describe, expect, test } from 'vitest';

import type { MyPullRequest } from '@pr-quest/contract/api';
import {
  authorObservationsOf,
  buildMyPullRequestsQuery,
  mergeStateOf,
  parseMyPullRequestsPage,
  reviewStateOf,
  sortMyPullRequests,
  toMyPullRequest,
  type AuthoredPullRequest,
} from './myPullRequests.ts';
import { fixture } from './test-utils/fixtures.ts';

const page = () => parseMyPullRequestsPage(fixture('graphql-my-prs.json'));

function openPr(number: number): AuthoredPullRequest {
  const pr = page().open?.pullRequests.find((entry) => entry.number === number);
  if (!pr) {
    throw new Error(`the fixture has no open PR #${number}`);
  }
  return pr;
}

function donePr(number: number): AuthoredPullRequest {
  const pr = page().done?.pullRequests.find((entry) => entry.number === number);
  if (!pr) {
    throw new Error(`the fixture has no merged or closed PR #${number}`);
  }
  return pr;
}

describe('buildMyPullRequestsQuery', () => {
  test('asks for both parts, with change requests only on merged and closed PRs', () => {
    const { query, variables } = buildMyPullRequestsQuery({ open: {}, done: {} });

    expect(query).toContain('open: pullRequests(first: $first, after: $openAfter, states: [OPEN]');
    expect(query).toContain('states: [MERGED, CLOSED], orderBy: { field: UPDATED_AT');
    expect(query).toContain('fragment MineDone on PullRequest');
    expect(query).toContain('REVIEW_DISMISSED_EVENT');
    expect(variables).toEqual({ first: 50 });
  });

  test('continues one part from its cursor and leaves the other out', () => {
    const { query, variables } = buildMyPullRequestsQuery({ done: { after: 'abc' } });

    expect(query).not.toContain('open: pullRequests');
    expect(variables).toEqual({ first: 50, doneAfter: 'abc' });
  });

  test('an open-only page asks for no change-request history', () => {
    const { query } = buildMyPullRequestsQuery({ open: { after: 'abc' } });

    expect(query).not.toContain('MineDone');
    expect(query).not.toContain('REVIEW_DISMISSED_EVENT');
  });
});

describe('parseMyPullRequestsPage', () => {
  test('skips a PR GitHub refused and counts only errors that may clear up on author XP fields', () => {
    const parsed = page();

    expect(parsed.viewerLogin).toBe('player-login');
    expect(parsed.open?.pullRequests.map((pr) => pr.number)).toEqual([40, 41, 42, 7]);
    expect(parsed.open?.skipped).toBe(1);
    // The one error is on `commits`, which only the card shows.
    expect(parsed.open?.otherErrors).toBe(0);
    expect(parsed.open).not.toHaveProperty('nextCursor');
    expect(parsed.done?.nextCursor).toBe('Y3Vyc29yOjI=');
    expect(parsed.done?.otherErrors).toBe(0);
  });

  test('throws when GitHub sent no data at all', () => {
    expect(() =>
      parseMyPullRequestsPage(JSON.stringify({ errors: [{ message: 'Bad credentials' }] })),
    ).toThrow('GitHub GraphQL returned no data: Bad credentials');
  });
});

describe('card derivation', () => {
  test('changes requested with an unresolved thread, failing CI and a conflict', () => {
    expect(toMyPullRequest(openPr(40))).toMatchObject({
      id: 'Trackunit/state-of-code#40',
      reviewState: 'changesRequested',
      ciState: 'failing',
      mergeState: 'conflicting',
      unresolvedThreads: 1,
      needsMyAction: true,
      difficulty: 'Trivial',
      author: { name: 'Player One', githubLogin: 'player-login' },
      headSha: '1111111111111111111111111111111111111111',
    });
  });

  test('an approved, passing, clean PR needs nothing from me', () => {
    expect(toMyPullRequest(openPr(41))).toMatchObject({
      reviewState: 'approved',
      ciState: 'passing',
      mergeState: 'clean',
      unresolvedThreads: 0,
      needsMyAction: false,
    });
  });

  test('a draft with no checks that is behind, and more threads than were read', () => {
    const card = toMyPullRequest(openPr(42));

    expect(card).toMatchObject({
      isDraft: true,
      reviewState: 'waiting',
      ciState: 'none',
      mergeState: 'behind',
      unresolvedThreads: 0,
      moreThreads: true,
      needsMyAction: false,
    });
  });

  test('CI and merge state read "unknown" when GitHub could not say, never "passing"', () => {
    expect(toMyPullRequest(openPr(7))).toMatchObject({ ciState: 'unknown', mergeState: 'unknown' });
  });

  test('a reviewer who commented after requesting changes still reads "changes requested"', () => {
    expect(reviewStateOf([{ state: 'APPROVED' }, { state: 'CHANGES_REQUESTED' }])).toBe(
      'changesRequested',
    );
    expect(reviewStateOf([])).toBe('waiting');
  });

  test('"needs my action" is exactly changes requested or unresolved threads', () => {
    const base = openPr(41);

    expect(toMyPullRequest({ ...base, unresolvedThreads: 2 }).needsMyAction).toBe(true);
    expect(toMyPullRequest({ ...base, reviewState: 'changesRequested' }).needsMyAction).toBe(true);
    expect(
      toMyPullRequest({ ...base, ciState: 'failing', mergeState: 'conflicting' }).needsMyAction,
    ).toBe(false);
  });

  test('merge states: conflicts win, BEHIND only when GitHub says so', () => {
    expect(mergeStateOf('CONFLICTING', 'BEHIND')).toBe('conflicting');
    expect(mergeStateOf('MERGEABLE', 'BLOCKED')).toBe('clean');
    expect(mergeStateOf('MERGEABLE', 'BEHIND')).toBe('behind');
    expect(mergeStateOf(undefined, 'CLEAN')).toBe('unknown');
  });
});

describe('authorObservationsOf', () => {
  test('a merged PR reports its merge, earliest approval and resolved threads', () => {
    expect(authorObservationsOf(donePr(35), 'player-login')).toEqual([
      {
        kind: 'merged',
        prId: 'Trackunit/state-of-code#35',
        mergedAt: '2026-10-29T10:00:00Z',
        tier: 'Normal',
        resolvedThreads: 3,
        everChangesRequested: true,
        createdAt: '2026-10-26T09:00:00Z',
      },
      {
        kind: 'approved',
        prId: 'Trackunit/state-of-code#35',
        submittedAt: '2026-10-28T09:00:00Z',
        tier: 'Normal',
      },
      ...['a', 'b', 'c'].map((suffix) => ({
        kind: 'threadResolved',
        prId: 'Trackunit/state-of-code#35',
        threadId: `PRRT_done35_${suffix}`,
        tier: 'Normal',
        prCreatedAt: '2026-10-26T09:00:00Z',
      })),
    ]);
  });

  test("the approval is the earliest by someone else, never the player's own", () => {
    const approvals = authorObservationsOf(openPr(41), 'player-login').filter(
      (observation) => observation.kind === 'approved',
    );

    expect(approvals).toEqual([expect.objectContaining({ submittedAt: '2026-10-30T07:00:00Z' })]);
  });

  test('a closed PR that was never merged reports no merge', () => {
    expect(authorObservationsOf(donePr(33), 'player-login')).toEqual([]);
  });

  test('a merged PR with no change request, current or dismissed, can be flawless', () => {
    const [merged] = authorObservationsOf({ ...donePr(35), everChangesRequested: false }, 'x');

    expect(merged).toMatchObject({ kind: 'merged', everChangesRequested: false });
  });
});

describe('sortMyPullRequests', () => {
  const card = (id: string, overrides: Partial<MyPullRequest>): MyPullRequest => ({
    ...toMyPullRequest(openPr(41)),
    id,
    ...overrides,
  });

  test('needs my action, then waiting on others, then the rest; oldest first in each', () => {
    const sorted = sortMyPullRequests([
      card('approved-old', { reviewState: 'approved', openedAt: '2026-01-01T00:00:00Z' }),
      card('waiting-new', { reviewState: 'waiting', openedAt: '2026-10-02T00:00:00Z' }),
      card('action-new', { needsMyAction: true, openedAt: '2026-10-03T00:00:00Z' }),
      card('waiting-old', { reviewState: 'waiting', openedAt: '2026-10-01T00:00:00Z' }),
      card('action-old', { needsMyAction: true, openedAt: '2026-09-01T00:00:00Z' }),
    ]);

    expect(sorted.map((pr) => pr.id)).toEqual([
      'action-old',
      'action-new',
      'waiting-old',
      'waiting-new',
      'approved-old',
    ]);
  });
});
