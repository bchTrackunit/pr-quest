import type { DifficultyTier } from '@pr-quest/contract/api';

/** At most this many resolved threads pay author XP per PR. */
export const MAX_PAID_THREADS = 5;

/** Merges Small Batch looks back over. */
export const SMALL_BATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Something PR Quest read off one of the player's PRs. `prId` is `<owner>/<repo>#<number>`;
 * `tier` is the PR's tier when PR Quest read it.
 */
export type AuthorObservation =
  | {
      kind: 'merged';
      prId: string;
      mergedAt: string;
      tier: DifficultyTier;
      /** Threads GitHub reports as resolved, whether or not they paid. */
      resolvedThreads: number;
      /** Someone requested changes, even if the request was later dismissed. */
      everChangesRequested: boolean;
      createdAt: string;
    }
  | {
      kind: 'approved';
      prId: string;
      /** When the earliest approval by someone else was submitted. */
      submittedAt: string;
      tier: DifficultyTier;
    }
  | {
      kind: 'threadResolved';
      prId: string;
      threadId: string;
      tier: DifficultyTier;
      prCreatedAt: string;
    };

export interface AuthorActivity {
  observations: Array<AuthorObservation>;
  /** Every PR read in this sync, as `prId`; each one PR Quest hasn't seen gets a record. */
  readPrs: Array<string>;
  /** The new sync point for merged and closed PRs; left out when it must hold. */
  lastAuthorSync?: string;
  /** When the read started; the first sync starts tracking here, so nothing after it is missed. */
  readAt?: string;
}

/** What PR Quest knows about one of the player's PRs. A PR has been seen once it has a record. */
export interface AuthorPrRecord {
  /** The merge was settled: it paid, or it happened before tracking started. */
  merged?: true;
  /** The approval was settled: it paid, or the first approval came before tracking started. */
  approved?: true;
  /** Threads whose resolution paid; at most `MAX_PAID_THREADS`. */
  paidThreads: Array<string>;
  /** Threads already resolved before PR Quest could watch them; they never pay. */
  baselineThreads: Array<string>;
}

export interface RecentMerge {
  pr: string;
  mergedAt: string;
  tier: DifficultyTier;
}

/** Author XP history. `authorPrs` is never trimmed, so no PR can pay twice. */
export interface AuthorLedger {
  /** When author tracking started; nothing that happened before pays. */
  trackingSince?: string;
  /** Merged and closed PRs are read back to this point. */
  lastAuthorSync?: string;
  /** Keyed by `prKey`. */
  authorPrs: Record<string, AuthorPrRecord>;
  /** Paid merges of the last 7 days, for Small Batch. */
  recentMerges: Array<RecentMerge>;
  /** Paid merges, for Ship It. */
  merges: number;
  /** Paid merges of PRs nobody ever requested changes on, for Flawless Victory. */
  flawlessMerges: number;
  /** Paid merges with at least 3 resolved threads, for All Tied Up. */
  tiedUpMerges: number;
}

export function emptyAuthorLedger(): AuthorLedger {
  return { authorPrs: {}, recentMerges: [], merges: 0, flawlessMerges: 0, tiedUpMerges: 0 };
}

/** Small merges (Trivial or Normal) within the last 7 days before `now`. */
export function smallMergesSince(ledger: AuthorLedger, now: Date): number {
  const since = now.getTime() - SMALL_BATCH_WINDOW_MS;
  return ledger.recentMerges.filter(
    (merge) =>
      (merge.tier === 'Trivial' || merge.tier === 'Normal') && Date.parse(merge.mergedAt) >= since,
  ).length;
}
