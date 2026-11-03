import { describe, expect, test } from 'vitest';

import { cursorReviewBlocker, type CursorReviewTarget } from './cursorReview.ts';

const member: CursorReviewTarget = {
  id: 'Trackunit/manager#7',
  author: { name: 'Ada', githubLogin: 'ada' },
  authorAssociation: 'MEMBER',
  isCrossRepository: false,
  sourceBranch: 'feature/cache',
  targetBranch: 'master',
};

const dependabot: CursorReviewTarget = {
  ...member,
  author: { name: 'dependabot', githubLogin: 'dependabot[bot]' },
  authorAssociation: 'NONE',
  sourceBranch: 'dependabot/npm_and_yarn/team-gluon-react-6a1b2c3d4e',
};

describe('cursorReviewBlocker', () => {
  test.each([
    ['a member', member],
    ['Dependabot', dependabot],
  ])('lets the Cursor agent review a PR by %s', (_label, quest) => {
    expect(cursorReviewBlocker(quest)).toBeUndefined();
  });

  test.each([{ authorAssociation: undefined }, { isCrossRepository: undefined }])(
    'asks for a refresh while it is unknown who could push the branch: %o',
    (unknown) => {
      expect(cursorReviewBlocker({ ...member, ...unknown })).toContain('Refresh the board');
    },
  );

  test('refuses a contributor outside the org', () => {
    expect(cursorReviewBlocker({ ...member, authorAssociation: 'CONTRIBUTOR' })).toContain(
      '(CONTRIBUTOR)',
    );
  });

  test('refuses a NONE author without a GitHub login', () => {
    expect(cursorReviewBlocker({ ...dependabot, author: { name: 'dependabot[bot]' } })).toContain(
      '(NONE)',
    );
  });

  test.each([{ sourceBranch: 'dependabot/$(id)' }, { targetBranch: '-main' }])(
    'refuses a trusted bot PR with an unsafe branch name: %o',
    (branches) => {
      expect(cursorReviewBlocker({ ...dependabot, ...branches })).toContain('branch name');
    },
  );
});
