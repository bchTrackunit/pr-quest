import type { Quest } from './api.ts';
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
