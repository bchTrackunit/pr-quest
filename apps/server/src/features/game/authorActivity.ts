import type { DifficultyTier } from '@pr-quest/contract/api';
import {
  MAX_PAID_THREADS,
  SMALL_BATCH_WINDOW_MS,
  type AuthorActivity,
  type AuthorLedger,
  type AuthorObservation,
  type AuthorPrRecord,
} from './authorLedger.ts';
import {
  withStreakDay,
  withUnlocks,
  type GameState,
  type GameUpdate,
  type XpGrant,
} from './gamification.ts';
import { prKey } from './ledger.ts';
import { localDate } from './streak.ts';

export const AUTHOR_BASE_XP = {
  prMerged: 20,
  prApproved: 10,
  threadResolved: 3,
} as const;

/** Smaller PRs earn more, to encourage them. */
export const AUTHOR_TIER_MULTIPLIERS: Record<DifficultyTier, number> = {
  Trivial: 2,
  Normal: 1.5,
  Hard: 1,
  Boss: 0.5,
};

const MIN_TIED_UP_THREADS = 3;

type AuthorReason = keyof typeof AUTHOR_BASE_XP;

const authorXp = (reason: AuthorReason, tier: DifficultyTier): number =>
  Math.round(AUTHOR_BASE_XP[reason] * AUTHOR_TIER_MULTIPLIERS[tier]);

const isBefore = (iso: string, since: string): boolean => Date.parse(iso) < Date.parse(since);

/** Who owns the mutable copies while one activity is applied. */
interface Draft {
  state: GameState;
  author: AuthorLedger;
  records: Record<string, AuthorPrRecord>;
  grants: Array<XpGrant>;
  changed: boolean;
}

/**
 * Pays author XP for what PR Quest read off the player's PRs. Each merge, approval and resolved
 * thread pays at most once, ever; nothing that happened before tracking started pays; at most
 * `MAX_PAID_THREADS` threads pay per PR; and XP already earned is never taken back. Merges and
 * approvals count toward the streak on the day they happened, thread resolutions on `at`.
 */
export function applyAuthorActivity(
  state: GameState,
  activity: AuthorActivity,
  at: Date,
): GameUpdate {
  const firstSync = state.author.trackingSince === undefined;
  const trackingSince = state.author.trackingSince ?? activity.readAt ?? at.toISOString();
  const draft: Draft = {
    state,
    author: { ...state.author, trackingSince },
    records: { ...state.author.authorPrs },
    grants: [],
    changed: firstSync,
  };

  seeNewPrs(draft, activity, { firstSync, trackingSince });
  for (const observation of activity.observations) {
    apply(draft, observation, trackingSince, at);
  }
  const trimmed = draft.author.recentMerges.filter(
    (merge) => Date.parse(merge.mergedAt) >= at.getTime() - SMALL_BATCH_WINDOW_MS,
  );
  if (trimmed.length !== draft.author.recentMerges.length) {
    draft.author = { ...draft.author, recentMerges: trimmed };
    draft.changed = true;
  }
  if (activity.lastAuthorSync && activity.lastAuthorSync !== state.author.lastAuthorSync) {
    draft.author = { ...draft.author, lastAuthorSync: activity.lastAuthorSync };
    draft.changed = true;
  }
  if (!draft.changed) {
    return withUnlocks(state, [], at);
  }
  const xp = draft.grants.reduce((sum, grant) => sum + grant.amount, 0);
  const next: GameState = {
    ...draft.state,
    xp: draft.state.xp + xp,
    author: { ...draft.author, authorPrs: draft.records },
  };
  return withUnlocks(next, draft.grants, at);
}

/**
 * Gives each PR read for the first time a record. Threads resolved before PR Quest could watch
 * them are its baseline: on the first sync, and on PRs created before tracking started.
 */
function seeNewPrs(
  draft: Draft,
  activity: AuthorActivity,
  { firstSync, trackingSince }: { firstSync: boolean; trackingSince: string },
): void {
  const resolvedByPr = new Map<string, { createdAt: string; threads: Array<string> }>();
  for (const observation of activity.observations) {
    if (observation.kind === 'threadResolved') {
      const key = prKey(observation.prId);
      const entry = resolvedByPr.get(key) ?? { createdAt: observation.prCreatedAt, threads: [] };
      entry.threads.push(observation.threadId);
      resolvedByPr.set(key, entry);
    }
  }
  for (const prId of activity.readPrs) {
    const key = prKey(prId);
    if (Object.hasOwn(draft.records, key)) {
      continue;
    }
    const resolved = resolvedByPr.get(key);
    const unwatched =
      firstSync || (resolved !== undefined && isBefore(resolved.createdAt, trackingSince));
    draft.records[key] = {
      paidThreads: [],
      baselineThreads: unwatched && resolved ? [...new Set(resolved.threads)] : [],
    };
    draft.changed = true;
  }
}

function apply(
  draft: Draft,
  observation: AuthorObservation,
  trackingSince: string,
  at: Date,
): void {
  const key = prKey(observation.prId);
  const record = draft.records[key] ?? { paidThreads: [], baselineThreads: [] };
  switch (observation.kind) {
    case 'merged': {
      if (record.merged) {
        return;
      }
      draft.records[key] = { ...record, merged: true };
      draft.changed = true;
      if (isBefore(observation.mergedAt, trackingSince)) {
        return;
      }
      pay(draft, 'prMerged', observation.prId, observation.tier, observation.mergedAt, at);
      const author = draft.author;
      draft.author = {
        ...author,
        merges: author.merges + 1,
        flawlessMerges: author.flawlessMerges + (observation.everChangesRequested ? 0 : 1),
        tiedUpMerges:
          author.tiedUpMerges + (observation.resolvedThreads >= MIN_TIED_UP_THREADS ? 1 : 0),
        recentMerges: [
          ...author.recentMerges,
          { pr: key, mergedAt: observation.mergedAt, tier: observation.tier },
        ],
      };
      return;
    }
    case 'approved': {
      if (record.approved) {
        return;
      }
      draft.records[key] = { ...record, approved: true };
      draft.changed = true;
      if (isBefore(observation.submittedAt, trackingSince)) {
        return;
      }
      pay(draft, 'prApproved', observation.prId, observation.tier, observation.submittedAt, at);
      return;
    }
    case 'threadResolved': {
      const { threadId } = observation;
      if (
        record.baselineThreads.includes(threadId) ||
        record.paidThreads.includes(threadId) ||
        record.paidThreads.length >= MAX_PAID_THREADS
      ) {
        return;
      }
      draft.records[key] = { ...record, paidThreads: [...record.paidThreads, threadId] };
      draft.changed = true;
      pay(draft, 'threadResolved', observation.prId, observation.tier, at.toISOString(), at);
      return;
    }
    default:
      return;
  }
}

/** Grants the XP and counts `happenedAt`'s local day toward the streak. */
function pay(
  draft: Draft,
  reason: AuthorReason,
  prId: string,
  tier: DifficultyTier,
  happenedAt: string,
  at: Date,
): void {
  draft.grants.push({ amount: authorXp(reason, tier), reason, questId: prId });
  draft.state = withStreakDay(draft.state, localDate(new Date(happenedAt)), at);
}
