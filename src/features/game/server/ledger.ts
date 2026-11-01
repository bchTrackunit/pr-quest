import type { FindingSeverity, QuestAuthor, ReviewProvider } from '../../../shared/api.ts';

/** Lists in the ledger keep at most this many entries, dropping the oldest. */
export const MAX_LEDGER_ENTRIES = 1000;

const BOT_LOGINS = /^(?:dependabot|renovate)(?:-preview|-bot)?$/;

/** Counters for one local calendar day; the first action on another day starts them again. */
export interface DayLedger {
  /** Local calendar date (`YYYY-MM-DD`). */
  date: string;
  /** Trivial-tier approvals of PRs that had a posted review or a finished agent run first. */
  trivialApprovals: number;
  /** PR keys of direct requests with a review action. */
  directPrs: Array<string>;
}

/**
 * The history achievements need beyond the counters. PRs are keyed by `prKey`, so a quest and an
 * agent run on the same repo and number match whatever the case of the owner or repo.
 */
export interface AchievementLedger {
  /** Lower-cased `owner/repo` of each repo with a review action. */
  repos: Array<string>;
  /** `authorKey` of each PR author with a review action, the player and bots excluded. */
  authors: Array<string>;
  /** Dependabot and Renovate PRs with a review action. */
  botPrs: Array<string>;
  /** PRs the player requested changes on. */
  changesRequestedPrs: Array<string>;
  /** Approvals of Boss-tier PRs. Approvals already count once per PR. */
  bossApprovals: number;
  /** Posted reviews with at least one critical or major finding. */
  highSeverityReviews: number;
  /** PRs with a posted review or a finished agent review; approving them isn't a rubber stamp. */
  reviewedPrs: Array<string>;
  /** Which providers finished a review of each PR. */
  runProviders: Record<string, Array<ReviewProvider>>;
  day?: DayLedger;
}

export function emptyLedger(): AchievementLedger {
  return {
    repos: [],
    authors: [],
    botPrs: [],
    changesRequestedPrs: [],
    bossApprovals: 0,
    highSeverityReviews: 0,
    reviewedPrs: [],
    runProviders: {},
  };
}

/** `owner/repo#number`, lower-cased, from a quest id. */
export function prKey(questId: string): string {
  return questId.toLowerCase();
}

/** `owner/repo`, lower-cased, from a quest id. */
export function repoKey(questId: string): string {
  const key = prKey(questId);
  const hash = key.lastIndexOf('#');
  return hash === -1 ? key : key.slice(0, hash);
}

/**
 * The author's GitHub login without the `app/` prefix or `[bot]` suffix, so `dependabot[bot]` and
 * `app/dependabot` are one author. `undefined` when the login is unknown.
 */
export function authorKey(author: QuestAuthor | undefined): string | undefined {
  const login = author?.githubLogin?.trim().toLowerCase();
  if (!login) {
    return undefined;
  }
  return login.replace(/^app\//, '').replace(/\[bot\]$/, '');
}

/** Dependabot or Renovate, the bots Bot Wrangler counts; `key` comes from `authorKey`. */
export function isBotAuthor(key: string): boolean {
  return BOT_LOGINS.test(key);
}

/** Any bot or GitHub App login, or Dependabot or Renovate under their bare names. */
export function isAnyBot(author: QuestAuthor | undefined): boolean {
  const login = author?.githubLogin?.trim().toLowerCase();
  if (!login) {
    return false;
  }
  return login.startsWith('app/') || login.endsWith('[bot]') || BOT_LOGINS.test(login);
}

/** Eagle Eye's "high severity": the top two levels of the review result schema. */
export function isHighSeverity(severity: FindingSeverity): boolean {
  return severity === 'critical' || severity === 'major';
}

/** Adds `entry` once, moving it to the end, and keeps the newest `MAX_LEDGER_ENTRIES`. */
export function withEntry(list: ReadonlyArray<string>, entry: string): Array<string> {
  if (list.at(-1) === entry) {
    return [...list];
  }
  return [...list.filter((existing) => existing !== entry), entry].slice(-MAX_LEDGER_ENTRIES);
}

export function withRunProvider(
  runProviders: Readonly<Record<string, ReadonlyArray<ReviewProvider>>>,
  key: string,
  provider: ReviewProvider,
): Record<string, Array<ReviewProvider>> {
  const providers = runProviders[key] ?? [];
  const others = Object.entries(runProviders)
    .filter(([existing]) => existing !== key)
    .map(([existing, list]): [string, Array<ReviewProvider>] => [existing, [...list]]);
  const entry: [string, Array<ReviewProvider>] = [
    key,
    providers.includes(provider) ? [...providers] : [...providers, provider],
  ];
  return Object.fromEntries([...others, entry].slice(-MAX_LEDGER_ENTRIES));
}
