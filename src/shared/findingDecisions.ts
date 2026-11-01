import type { FindingDecision, ReviewRun } from './api.ts';

type DecidedRun = Pick<ReviewRun, 'result' | 'findingDecisions'>;

/** One decision per finding, `undecided` where none was saved. */
export function findingDecisionsOf(run: DecidedRun): Array<FindingDecision> {
  return (run.result?.findings ?? []).map(
    (_finding, index) => run.findingDecisions?.[index] ?? 'undecided',
  );
}

/** The ids of the findings a post may include, in result order. */
export function acceptedFindingIndexes(run: DecidedRun): Array<number> {
  return findingDecisionsOf(run).flatMap((decision, index) =>
    decision === 'accepted' ? [index] : [],
  );
}
