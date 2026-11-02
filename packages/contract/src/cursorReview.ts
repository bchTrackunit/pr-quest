import type { Quest } from './api.ts';
import {
  type DiscussionComment,
  discussionSize,
  type PullRequestDiscussion,
} from './discussion.ts';
import { isPromptSafeBranch } from './reviewResult.ts';

/**
 * Roles GitHub gives people in the repo's org or invited to it. None of them implies write access,
 * which only a head branch in the base repo shows, so the Cursor agent also needs one of those.
 */
const TRUSTED_AUTHOR_ASSOCIATIONS: ReadonlySet<string> = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
]);

/**
 * GitHub Apps whose PRs the Cursor agent reviews although GitHub gives them no role (`NONE`).
 * GitHub reserves the `[bot]` suffix for apps, so no person can sign up under one of these logins.
 * Only REST logins keep that suffix; GraphQL's `author.login` drops it (`dependabot`), so never
 * compare these against GraphQL logins. Their PR content comes from upstream
 * maintainers who can't push, which the README's review agent section spells out.
 */
const TRUSTED_BOT_LOGINS: ReadonlySet<string> = new Set(['dependabot[bot]', 'renovate[bot]']);

export type CursorReviewTarget = Pick<
  Quest,
  'id' | 'author' | 'authorAssociation' | 'isCrossRepository' | 'sourceBranch' | 'targetBranch'
>;

/**
 * Why the Cursor agent won't review the quest, or `undefined` when it will. The agent runs PR
 * content in the repo with the player's Cursor GitHub integration, and only its prompt stops it
 * from pushing, so it reviews only PRs pushed to the base repo by its org's members, its
 * collaborators or a trusted bot, on branches whose names are safe in the commands its prompt
 * contains. Claude can't act, so it reviews anything.
 */
export function cursorReviewBlocker(quest: CursorReviewTarget): string | undefined {
  const association = quest.authorAssociation;
  if (!association || quest.isCrossRepository === undefined) {
    return `PR Quest doesn't know who could push ${quest.id}'s branch yet. Refresh the board, then send the agent again.`;
  }
  const login = quest.author.githubLogin?.toLowerCase();
  const isTrustedBot = login !== undefined && TRUSTED_BOT_LOGINS.has(login);
  if (!TRUSTED_AUTHOR_ASSOCIATIONS.has(association) && !isTrustedBot) {
    return `${quest.id} is by an author outside the repo's org and collaborators (${association}), and its content could steer the Cursor agent. Review it with Claude instead.`;
  }
  if (quest.isCrossRepository) {
    return `${quest.id} comes from a fork, so its author may not be able to push to the repo, and its content could steer the Cursor agent. Review it with Claude instead.`;
  }
  if (!isPromptSafeBranch(quest.sourceBranch) || !isPromptSafeBranch(quest.targetBranch)) {
    return `${quest.id} has a branch name the Cursor agent can't use safely in a command. Review it with Claude instead.`;
  }
  return undefined;
}

/**
 * Review bots whose comments the Cursor agent reads, by GraphQL login: Bugbot, Copilot and
 * CodeRabbit. They write about PR content the agent reads anyway. Other apps, `github-actions`
 * among them, may post text that anyone wrote.
 */
const TRUSTED_REVIEW_BOTS: ReadonlySet<string> = new Set([
  'cursor',
  'copilot-pull-request-reviewer',
  'coderabbitai',
]);

export interface CursorDiscussion {
  discussion: PullRequestDiscussion;
  /** Comments whose authors the agent may not read. */
  leftOut: number;
}

/**
 * Logins worth checking for write access: only the repo's org members and collaborators can have
 * it, though none of those roles implies it.
 */
export function pushCandidates(discussion: PullRequestDiscussion): Array<string> {
  const comments = [
    ...discussion.reviews,
    ...discussion.threads.flatMap((thread) => thread.comments),
    ...discussion.conversation,
  ];
  const logins = comments.flatMap((comment) =>
    !comment.isBot &&
    comment.authorAssociation !== undefined &&
    TRUSTED_AUTHOR_ASSOCIATIONS.has(comment.authorAssociation)
      ? [comment.author.toLowerCase()]
      : [],
  );
  return [...new Set(logins)];
}

/**
 * The comments the Cursor agent may read so it doesn't repeat them: those by `pushers`, the
 * lower-cased logins that can push to the repo, and by trusted review bots. Anyone else could
 * steer the agent through a comment, so theirs are left out, and so is a bot's reply that follows
 * one in a thread, since it may quote it.
 */
export function discussionForCursor(
  discussion: PullRequestDiscussion,
  pushers: ReadonlySet<string>,
): CursorDiscussion {
  const readable = (comment: DiscussionComment): boolean =>
    comment.isBot
      ? TRUSTED_REVIEW_BOTS.has(comment.author.toLowerCase())
      : pushers.has(comment.author.toLowerCase());
  const threads = discussion.threads.flatMap((thread) => {
    const firstUnreadable = thread.comments.findIndex((comment) => !readable(comment));
    const comments = thread.comments.filter(
      (comment, index) =>
        readable(comment) && !(comment.isBot && firstUnreadable >= 0 && index > firstUnreadable),
    );
    return comments.length > 0 ? [{ ...thread, comments }] : [];
  });
  const kept: PullRequestDiscussion = {
    reviews: discussion.reviews.filter(readable),
    threads,
    conversation: discussion.conversation.filter(readable),
  };
  return { discussion: kept, leftOut: discussionSize(discussion) - discussionSize(kept) };
}
