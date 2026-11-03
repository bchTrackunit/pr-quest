import type { ReviewRun } from './api.ts';

type SelectableRun = Pick<ReviewRun, 'result' | 'selectedFindings'>;

/** The ids of the findings a post may include: the selected ones the run has, ascending. */
export function selectedFindingIndexes(run: SelectableRun): Array<number> {
  const findingCount = run.result?.findings.length ?? 0;
  const selected = new Set(run.selectedFindings ?? []);
  return Array.from({ length: findingCount }, (_finding, index) => index).filter((index) =>
    selected.has(index),
  );
}
