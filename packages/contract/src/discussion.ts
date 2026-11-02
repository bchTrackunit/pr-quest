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

export function discussionSize(discussion: PullRequestDiscussion): number {
  return (
    discussion.reviews.length +
    discussion.threads.reduce((count, thread) => count + thread.comments.length, 0) +
    discussion.conversation.length
  );
}
