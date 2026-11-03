import { describe, expect, test } from 'vitest';

import {
  type DiscussionComment,
  type DiscussionThread,
  pushCandidates,
  trustedDiscussion,
} from './discussion.ts';

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

describe('trustedDiscussion', () => {
  const pushers = new Set(['ada']);

  test('keeps comments by people who can push, whatever their role', () => {
    const ada = by('Ada', 'CONTRIBUTOR');

    expect(
      trustedDiscussion({ reviews: [ada], threads: [], conversation: [ada] }, pushers),
    ).toEqual({ discussion: { reviews: [ada], threads: [], conversation: [ada] }, leftOut: 0 });
  });

  test('leaves out and counts members and collaborators who cannot push', () => {
    const ada = by('ada', 'MEMBER');
    const { discussion, leftOut } = trustedDiscussion(
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
        trustedDiscussion({ reviews: [], threads: [], conversation: [bot] }, pushers).discussion
          .conversation,
      ).toEqual([bot]);
    },
  );

  test('leaves out other bots, and people who share a review bot login', () => {
    const { discussion, leftOut } = trustedDiscussion(
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
      trustedDiscussion(
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
