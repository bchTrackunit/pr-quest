import { describe, expect, test } from 'vitest';

import type { ReviewResult } from './api.ts';
import { selectedFindingIndexes } from './findingSelection.ts';

const result: ReviewResult = {
  summary: 'Three findings.',
  verdict: 'comment',
  findings: [
    { file: 'a.ts', line: 1, severity: 'major', body: 'A' },
    { file: 'b.ts', severity: 'minor', body: 'B' },
    { file: 'c.ts', line: 3, severity: 'nit', body: 'C' },
  ],
};

describe('selectedFindingIndexes', () => {
  test('is empty until the player selects a finding', () => {
    expect(selectedFindingIndexes({ result })).toEqual([]);
  });

  test('lists the selected findings in result order, once each', () => {
    expect(selectedFindingIndexes({ result, selectedFindings: [2, 0, 2] })).toEqual([0, 2]);
  });

  test('ignores indexes the result does not have', () => {
    expect(selectedFindingIndexes({ result, selectedFindings: [1, 3, 7] })).toEqual([1]);
    expect(selectedFindingIndexes({ selectedFindings: [0] })).toEqual([]);
  });
});
