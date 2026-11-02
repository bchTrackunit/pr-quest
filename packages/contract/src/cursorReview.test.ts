import { describe, expect, test } from 'vitest';

import {
  cursorReviewBlocker,
  type CursorReviewTarget,
  discussionForCursor,
  pushCandidates,
} from './cursorReview.ts';
import type { DiscussionComment, DiscussionThread } from './discussion.ts';

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

const by = (author: string, authorAssociation?: string, isBot = false): DiscussionComment =>
  authorAssociation === undefined
    ? { author, isBot, body: `${author} says hi` }
    : { author, authorAssociation, isBot, body: `${author} says hi` };

const thread = (comments: Array<DiscussionComment>): DiscussionThread => ({
  file: 'src/a.ts',
  line: 3,
  resolved: false,
  outdated: false,
  comments,
});

describe('pushCandidates', () => {
  test('lists each org member, owner and collaborator once, lower-cased', () => {
    expect(
      pushCandidates({
        reviews: [by('Ada', 'MEMBER'), by('bob', 'OWNER')],
        threads: [thread([by('ada', 'MEMBER'), by('carol', 'COLLABORATOR')])],
        conversation: [by('mallory', 'CONTRIBUTOR'), by('eve'), by('cursor', 'MEMBER', true)],
      }),
    ).toEqual(['ada', 'bob', 'carol']);
  });
});

describe('discussionForCursor', () => {
  const pushers = new Set(['ada']);

  test('keeps comments by people who can push, whatever their role', () => {
    const ada = by('Ada', 'CONTRIBUTOR');

    expect(
      discussionForCursor({ reviews: [ada], threads: [], conversation: [ada] }, pushers),
    ).toEqual({ discussion: { reviews: [ada], threads: [], conversation: [ada] }, leftOut: 0 });
  });

  test('leaves out and counts members and collaborators who cannot push', () => {
    const ada = by('ada', 'MEMBER');
    const { discussion, leftOut } = discussionForCursor(
      {
        reviews: [by('reader', 'MEMBER')],
        threads: [thread([ada, by('triager', 'COLLABORATOR')]), thread([by('eve', 'NONE')])],
        conversation: [by('ghost')],
      },
      pushers,
    );

    expect(discussion).toEqual({ reviews: [], threads: [thread([ada])], conversation: [] });
    expect(leftOut).toBe(4);
  });

  test.each(['cursor', 'copilot-pull-request-reviewer', 'CodeRabbitAI'])(
    'keeps comments by the %s review bot',
    (login) => {
      const bot = by(login, 'NONE', true);

      expect(
        discussionForCursor({ reviews: [], threads: [], conversation: [bot] }, pushers).discussion
          .conversation,
      ).toEqual([bot]);
    },
  );

  test('leaves out other bots, and people who share a review bot login', () => {
    const { discussion, leftOut } = discussionForCursor(
      {
        reviews: [],
        threads: [],
        conversation: [by('github-actions', 'NONE', true), by('cursor', 'NONE')],
      },
      pushers,
    );

    expect(discussion.conversation).toEqual([]);
    expect(leftOut).toBe(2);
  });

  test("drops a review bot's reply that follows an untrusted comment in its thread", () => {
    const bugbot = by('cursor', 'NONE', true);
    const ada = by('ada', 'MEMBER');

    expect(
      discussionForCursor(
        {
          reviews: [],
          threads: [thread([bugbot, by('eve', 'NONE'), bugbot, ada])],
          conversation: [],
        },
        pushers,
      ),
    ).toEqual({
      discussion: { reviews: [], threads: [thread([bugbot, ada])], conversation: [] },
      leftOut: 2,
    });
  });
});
