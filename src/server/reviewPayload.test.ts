import { describe, expect, test } from 'vitest';

import type { ReviewFinding } from '../shared/api.ts';
import { renderReview } from './reviewPayload.ts';

const findings: Array<ReviewFinding> = [
  { file: 'src/a.ts', line: 10, severity: 'critical', body: 'SQL injection.' },
  { file: './src/b.ts', line: 0, severity: 'minor', body: 'Bad line number.' },
  { file: 'README.md', severity: 'nit', body: 'Typo.' },
];

const draft = {
  event: 'comment' as const,
  summary: 'One serious problem.',
  verdict: 'requestChanges' as const,
  commitId: 'sha1',
  findings,
};

describe('renderReview', () => {
  test('puts findings with a valid line inline with a severity prefix', () => {
    const payload = renderReview(draft, { inline: true });

    expect(payload.comments).toEqual([
      { path: 'src/a.ts', line: 10, side: 'RIGHT', body: '**[Critical]** SQL injection.' },
    ]);
    expect(payload.commit_id).toBe('sha1');
    expect(payload.event).toBe('COMMENT');
  });

  test('puts findings without a valid line in the body', () => {
    const payload = renderReview(draft, { inline: true });

    expect(payload.body).toContain('One serious problem.');
    expect(payload.body).toContain('**[Minor]** `src/b.ts`');
    expect(payload.body).toContain('**[Nit]** `README.md`');
    expect(payload.body).not.toContain('SQL injection.');
  });

  test('puts every finding in the body when inline comments are off', () => {
    const payload = renderReview(draft, { inline: false });

    expect(payload.comments).toEqual([]);
    expect(payload.commit_id).toBeUndefined();
    expect(payload.body).toContain('**[Critical]** `src/a.ts:10`');
  });

  test('maps requestChanges to the GitHub event', () => {
    expect(renderReview({ ...draft, event: 'requestChanges' }, { inline: true }).event).toBe(
      'REQUEST_CHANGES',
    );
  });

  test('mentions the advisory verdict', () => {
    expect(renderReview(draft, { inline: true }).body).toContain('Agent verdict: request changes');
  });
});
