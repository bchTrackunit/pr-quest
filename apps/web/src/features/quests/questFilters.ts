import type { DifficultyTier, Quest, RequestKind, ReviewRun } from '@pr-quest/contract/api';
import { questLabel, sortQuests } from '../game/index.ts';

export const DIFFICULTY_TIERS: ReadonlyArray<DifficultyTier> = [
  'Trivial',
  'Normal',
  'Hard',
  'Boss',
];

export type KindFilter = 'all' | RequestKind;

/** Where the quest's review agent is: `running` covers queued and running runs. */
export type AgentState = 'notStarted' | 'running' | 'lootReady' | 'failed';

export const AGENT_STATES: ReadonlyArray<{ value: AgentState; label: string }> = [
  { value: 'notStarted', label: 'Not started' },
  { value: 'running', label: 'Running' },
  { value: 'lootReady', label: 'Loot ready' },
  { value: 'failed', label: 'Failed' },
];

export const KIND_LABELS: Record<KindFilter, string> = {
  all: 'All',
  direct: 'Direct',
  team: 'Team',
};

export type SortMode = 'smart' | 'size' | 'created';

/**
 * For `size`: `asc` is smallest first (quick wins), `desc` largest first (boss rush). For
 * `created`: `asc` is the oldest PR first, `desc` the newest.
 */
export type SortDirection = 'asc' | 'desc';

export interface QuestFilters {
  search: string;
  kind: KindFilter;
  /** Empty matches every tier. */
  tiers: Array<DifficultyTier>;
  hideDrafts: boolean;
  hideApproved: boolean;
  /** Empty matches every agent state. */
  agentStates: Array<AgentState>;
}

export interface QuestSort {
  mode: SortMode;
  direction: SortDirection;
}

export interface BoardView {
  filters: QuestFilters;
  sort: QuestSort;
}

export const DEFAULT_FILTERS: QuestFilters = {
  search: '',
  kind: 'all',
  tiers: [],
  hideDrafts: false,
  hideApproved: false,
  agentStates: [],
};

export const DEFAULT_SORT: QuestSort = { mode: 'smart', direction: 'asc' };

export const DEFAULT_VIEW: BoardView = { filters: DEFAULT_FILTERS, sort: DEFAULT_SORT };

/** Finds the run a quest card shows; `selectRunForQuest` bound to the current runs. */
export type RunLookup = (quest: Quest) => ReviewRun | undefined;

/**
 * The agent state of the run a quest card shows. A run whose findings were posted matches no
 * state: the review is done, and the card offers a new agent.
 */
export function agentStateOf(run: ReviewRun | undefined): AgentState | undefined {
  if (!run) {
    return 'notStarted';
  }
  switch (run.status) {
    case 'queued':
    case 'running':
      return 'running';
    case 'error':
    case 'startupFailed':
      return 'failed';
    case 'finished':
      return run.disposition === 'pending' ? 'lootReady' : undefined;
    default:
      return undefined;
  }
}

type SearchTerm =
  | { kind: 'number'; number: number; owner?: string; repo?: string }
  | { kind: 'text'; text: string };

const NUMBER_TERM = /^#(\d+)$/;
const REPO_NUMBER_TERM = /^(?:([\w.-]+)\/)?([\w.-]+)#(\d+)$/;

/**
 * Splits a query into whitespace-separated terms that must all match. `#123` matches PR 123,
 * `repo#123` or `owner/repo#123` also the repo (by prefix, ignoring case), and anything else is a
 * case-insensitive substring of the title, author, branch or `owner/repo#number`.
 */
export function parseSearch(query: string): Array<SearchTerm> {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((token): SearchTerm => {
      const number = NUMBER_TERM.exec(token);
      if (number) {
        return { kind: 'number', number: Number(number[1]) };
      }
      const repoNumber = REPO_NUMBER_TERM.exec(token);
      if (repoNumber) {
        const [, owner, repo, digits] = repoNumber;
        const term: SearchTerm = { kind: 'number', number: Number(digits), repo };
        return owner ? { ...term, owner } : term;
      }
      return { kind: 'text', text: token };
    });
}

/** What search reads, which review requests and the player's own PRs both have. */
export type SearchablePullRequest = Pick<
  Quest,
  'number' | 'repo' | 'title' | 'author' | 'sourceBranch'
>;

function matchesTerm(quest: SearchablePullRequest, term: SearchTerm): boolean {
  if (term.kind === 'number') {
    return (
      quest.number === term.number &&
      (term.repo === undefined || quest.repo.name.toLowerCase().startsWith(term.repo)) &&
      (term.owner === undefined || quest.repo.owner.toLowerCase() === term.owner)
    );
  }
  return [
    quest.title,
    quest.author.name,
    quest.author.githubLogin ?? '',
    quest.sourceBranch,
    questLabel(quest),
  ].some((field) => field.toLowerCase().includes(term.text));
}

export function matchesSearch(quest: SearchablePullRequest, query: string): boolean {
  return parseSearch(query).every((term) => matchesTerm(quest, term));
}

/** Every filter except the request kind, so the kind buttons can show what each would leave. */
function matchesAllButKind(quest: Quest, filters: QuestFilters, runFor: RunLookup): boolean {
  if (filters.tiers.length > 0 && !filters.tiers.includes(quest.difficulty)) {
    return false;
  }
  if (filters.hideDrafts && quest.isDraft) {
    return false;
  }
  if (filters.hideApproved && quest.approvedByOthers) {
    return false;
  }
  if (filters.agentStates.length > 0) {
    const state = agentStateOf(runFor(quest));
    if (!state || !filters.agentStates.includes(state)) {
      return false;
    }
  }
  return matchesSearch(quest, filters.search);
}

export function filterQuests(
  quests: ReadonlyArray<Quest>,
  filters: QuestFilters,
  runFor: RunLookup,
): Array<Quest> {
  return quests.filter(
    (quest) =>
      (filters.kind === 'all' || quest.requestKind === filters.kind) &&
      matchesAllButKind(quest, filters, runFor),
  );
}

/** How many quests each request-kind button would show with the other filters applied. */
export function countByKind(
  quests: ReadonlyArray<Quest>,
  filters: QuestFilters,
  runFor: RunLookup,
): Record<KindFilter, number> {
  const matching = quests.filter((quest) => matchesAllButKind(quest, filters, runFor));
  return {
    all: matching.length,
    direct: matching.filter((quest) => quest.requestKind === 'direct').length,
    team: matching.filter((quest) => quest.requestKind === 'team').length,
  };
}

/** Lines changed: additions plus deletions. */
export function questSize(quest: Pick<Quest, 'diffStats'>): number {
  return quest.diffStats.additions + quest.diffStats.deletions;
}

/**
 * `smart`: direct first, then needs attention, then the longest-waiting. `size`: by lines changed,
 * then files changed. `created`: by when the PR was opened. The last two use the chosen direction,
 * and ties keep the smart order.
 */
export function sortBoardQuests(quests: ReadonlyArray<Quest>, sort: QuestSort): Array<Quest> {
  const smart = sortQuests(quests);
  if (sort.mode === 'smart') {
    return smart;
  }
  const sign = sort.direction === 'asc' ? 1 : -1;
  if (sort.mode === 'created') {
    return smart.sort(
      (left, right) => sign * (Date.parse(left.openedAt) - Date.parse(right.openedAt)),
    );
  }
  return smart.sort(
    (left, right) =>
      sign * (questSize(left) - questSize(right)) ||
      sign * (left.diffStats.fileCount - right.diffStats.fileCount),
  );
}

export interface FilterChip {
  key: string;
  label: string;
  /** The filters with this one removed. */
  without: QuestFilters;
}

/** One removable chip per active filter, in the order the controls appear. */
export function activeFilterChips(filters: QuestFilters): Array<FilterChip> {
  const chips: Array<FilterChip> = [];
  const search = filters.search.trim();
  if (search) {
    chips.push({
      key: 'search',
      label: `Search: “${search}”`,
      without: { ...filters, search: '' },
    });
  }
  if (filters.kind !== 'all') {
    chips.push({
      key: 'kind',
      label: `Requests: ${KIND_LABELS[filters.kind]}`,
      without: { ...filters, kind: 'all' },
    });
  }
  for (const tier of filters.tiers) {
    chips.push({
      key: `tier-${tier}`,
      label: `Tier: ${tier}`,
      without: { ...filters, tiers: filters.tiers.filter((entry) => entry !== tier) },
    });
  }
  if (filters.hideDrafts) {
    chips.push({ key: 'drafts', label: 'No drafts', without: { ...filters, hideDrafts: false } });
  }
  if (filters.hideApproved) {
    chips.push({
      key: 'approved',
      label: 'Not approved by others',
      without: { ...filters, hideApproved: false },
    });
  }
  for (const state of filters.agentStates) {
    const label = AGENT_STATES.find((entry) => entry.value === state)?.label ?? state;
    chips.push({
      key: `agent-${state}`,
      label: `Agent: ${label}`,
      without: {
        ...filters,
        agentStates: filters.agentStates.filter((entry) => entry !== state),
      },
    });
  }
  return chips;
}

/** Adds `value` when absent and removes it when present, keeping `order`. */
export function toggleValue<TValue>(
  values: ReadonlyArray<TValue>,
  value: TValue,
  order: ReadonlyArray<TValue>,
): Array<TValue> {
  const next = values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
  return order.filter((entry) => next.includes(entry));
}

export function viewsEqual(left: BoardView, right: BoardView): boolean {
  const a = left.filters;
  const b = right.filters;
  const sameSet = <TValue>(x: ReadonlyArray<TValue>, y: ReadonlyArray<TValue>): boolean =>
    x.length === y.length && x.every((entry) => y.includes(entry));
  return (
    a.search.trim() === b.search.trim() &&
    a.kind === b.kind &&
    sameSet(a.tiers, b.tiers) &&
    a.hideDrafts === b.hideDrafts &&
    a.hideApproved === b.hideApproved &&
    sameSet(a.agentStates, b.agentStates) &&
    left.sort.mode === right.sort.mode &&
    (left.sort.mode === 'smart' || left.sort.direction === right.sort.direction)
  );
}
