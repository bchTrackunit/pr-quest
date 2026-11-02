/** A comment already on a pull request. */
export interface DiscussionComment {
  /** GraphQL login, which drops the `[bot]` suffix that GitHub Apps have in REST. */
  author: string;
  /** GitHub's `CommentAuthorAssociation`, e.g. `MEMBER`; GitHub Apps usually get `NONE`. */
  authorAssociation?: string;
  isBot: boolean;
  body: string;
}

/** An inline review thread. */
export interface DiscussionThread {
  file: string;
  /** GitHub has no line for a thread whose code has changed since. */
  line?: number;
  resolved: boolean;
  outdated: boolean;
  comments: Array<DiscussionComment>;
}

/** What has already been said on a pull request, oldest first. */
export interface PullRequestDiscussion {
  /** Review summaries; reviews without a body are left out. */
  reviews: Array<DiscussionComment>;
  threads: Array<DiscussionThread>;
  /** Comments on the PR's conversation tab. */
  conversation: Array<DiscussionComment>;
}

/** The only roles that can come with write access to a repo, though none of them implies it. */
const PUSH_CAPABLE_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Review bots whose comments reviewers read, by GraphQL login: Bugbot, Copilot and CodeRabbit.
 * They write about PR content the reviewer reads anyway. Other apps, `github-actions` among them,
 * may post text that anyone wrote.
 */
const TRUSTED_REVIEW_BOTS: ReadonlySet<string> = new Set([
  'cursor',
  'copilot-pull-request-reviewer',
  'coderabbitai',
]);

export interface TrustedDiscussion {
  discussion: PullRequestDiscussion;
  /** Comments whose authors the reviewer may not read. */
  leftOut: number;
}

export function discussionSize(discussion: PullRequestDiscussion): number {
  return (
    discussion.reviews.length +
    discussion.threads.reduce((count, thread) => count + thread.comments.length, 0) +
    discussion.conversation.length
  );
}

/** Lower-cased logins worth checking for write access. */
export function pushCandidates(discussion: PullRequestDiscussion): Array<string> {
  const comments = [
    ...discussion.reviews,
    ...discussion.threads.flatMap((thread) => thread.comments),
    ...discussion.conversation,
  ];
  const logins = comments.flatMap((comment) =>
    !comment.isBot &&
    comment.authorAssociation !== undefined &&
    PUSH_CAPABLE_ASSOCIATIONS.has(comment.authorAssociation)
      ? [comment.author.toLowerCase()]
      : [],
  );
  return [...new Set(logins)];
}

/**
 * The comments a reviewer may read so it doesn't repeat them: those by `pushers`, the lower-cased
 * logins that can push to the repo, and by trusted review bots. A reviewer skips what comments
 * already raise, so anyone else could talk it out of a finding, and could steer the Cursor agent,
 * which can act. Their comments are left out, and so is a bot's reply that follows one in a
 * thread, since it may quote it.
 */
export function trustedDiscussion(
  discussion: PullRequestDiscussion,
  pushers: ReadonlySet<string>,
): TrustedDiscussion {
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
