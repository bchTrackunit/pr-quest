import type { DiffStats, DifficultyTier, Quest, RepoRef } from '../../../shared/api.ts';

const TRIVIAL_MAX_LINES = 50;
const NORMAL_MAX_LINES = 400;
const HARD_MAX_LINES = 2000;
const HARD_MAX_FILES = 50;

/** Tier from diff size, where lines are additions plus deletions. */
export function difficultyFor(stats: DiffStats): DifficultyTier {
  const lines = stats.additions + stats.deletions;
  if (lines < TRIVIAL_MAX_LINES) {
    return 'Trivial';
  }
  if (lines < NORMAL_MAX_LINES) {
    return 'Normal';
  }
  if (lines < HARD_MAX_LINES && stats.fileCount < HARD_MAX_FILES) {
    return 'Hard';
  }
  return 'Boss';
}

export interface QuestRef {
  repo: RepoRef;
  number: number;
}

/**
 * Owner and repo may not start with `-` so they can never be read as a `gh` flag, and `.`/`..`
 * are rejected so they can never become path segments in `gh api` routes.
 */
const QUEST_ID_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._][A-Za-z0-9._-]{0,99})#([1-9]\d{0,9})$/;

/** Parses `<owner>/<repo>#<number>`; returns `undefined` for anything that is not exactly that. */
export function parseQuestId(id: string): QuestRef | undefined {
  const match = QUEST_ID_PATTERN.exec(id);
  if (!match) {
    return undefined;
  }
  const [, owner = '', name = '', numberText = ''] = match;
  if (name === '.' || name === '..') {
    return undefined;
  }
  return { repo: { owner, name }, number: Number(numberText) };
}

export function formatQuestId(repo: RepoRef, number: number): string {
  return `${repo.owner}/${repo.name}#${number}`;
}

/** Direct requests first, then quests that need attention, then the longest-waiting. */
export function sortQuests(quests: ReadonlyArray<Quest>): Array<Quest> {
  return [...quests].sort(
    (a, b) =>
      rank(a.requestKind === 'direct') - rank(b.requestKind === 'direct') ||
      rank(a.needsAttention) - rank(b.needsAttention) ||
      Date.parse(a.requestedAt) - Date.parse(b.requestedAt),
  );
}

const rank = (first: boolean): number => (first ? 0 : 1);
