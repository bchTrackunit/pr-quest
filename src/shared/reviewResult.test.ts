import { describe, expect, test } from 'vitest';

import { buildReviewPrompt, parseReviewResult } from './reviewResult.ts';

const valid = {
  summary: 'Adds a cache.',
  verdict: 'comment',
  findings: [{ file: 'src/cache.ts', line: 12, severity: 'major', body: 'Unbounded growth.' }],
};

const fence = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;

describe('parseReviewResult', () => {
  test('parses the JSON fence at the end of the agent output', () => {
    expect(parseReviewResult(`I reviewed the diff.\n\n${fence(valid)}\n`)).toEqual({
      ok: true,
      result: valid,
    });
  });

  test('uses the last JSON fence when there are several', () => {
    const draft = { ...valid, summary: 'draft' };

    const parsed = parseReviewResult(`${fence(draft)}\nRevised:\n${fence(valid)}`);

    expect(parsed).toEqual({ ok: true, result: valid });
  });

  test('falls back to the last balanced object when there is no fence', () => {
    const text = `Notes {not json}. Final: ${JSON.stringify({ ...valid, summary: 'Uses "{braces}" in a string }' })}`;

    const parsed = parseReviewResult(text);

    expect(parsed.ok && parsed.result.summary).toBe('Uses "{braces}" in a string }');
  });

  test('normalizes severity and verdict spelling and drops a null line', () => {
    const parsed = parseReviewResult(
      fence({
        summary: 's',
        verdict: 'request_changes',
        findings: [{ file: 'a.ts', line: null, severity: 'Critical', body: 'b' }],
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      result: {
        summary: 's',
        verdict: 'requestChanges',
        findings: [{ file: 'a.ts', severity: 'critical', body: 'b' }],
      },
    });
  });

  test('accepts file-level findings without a line key', () => {
    const parsed = parseReviewResult(
      fence({
        summary: 's',
        verdict: 'comment',
        findings: [{ file: 'a.ts', severity: 'nit', body: 'b' }],
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      result: {
        summary: 's',
        verdict: 'comment',
        findings: [{ file: 'a.ts', severity: 'nit', body: 'b' }],
      },
    });
  });

  test('turns an invalid line into a file-level finding', () => {
    const parsed = parseReviewResult(
      fence({
        summary: 's',
        verdict: 'comment',
        findings: [{ file: 'a.ts', line: 0, severity: 'nit', body: 'b' }],
      }),
    );

    expect(parsed.ok && parsed.result.findings[0]).toEqual({
      file: 'a.ts',
      severity: 'nit',
      body: 'b',
    });
  });

  test('rejects an unknown verdict with a reason', () => {
    const parsed = parseReviewResult(fence({ ...valid, verdict: 'merge it' }));

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/verdict/);
  });

  test('rejects output without JSON', () => {
    expect(parseReviewResult('Looks good to me!')).toEqual({
      ok: false,
      error: 'The agent did not return a JSON review result',
    });
  });

  test('rejects empty output', () => {
    expect(parseReviewResult(undefined).ok).toBe(false);
  });

  test('returns the commit the agent says it reviewed next to the result', () => {
    expect(parseReviewResult(fence({ ...valid, reviewedSha: ' ABC1234 ' }))).toEqual({
      ok: true,
      result: valid,
      reviewedSha: 'abc1234',
    });
  });
});

describe('buildReviewPrompt', () => {
  const head = 'abcdef0123456789abcdef0123456789abcdef01';
  const prompt = buildReviewPrompt(
    {
      id: 'Trackunit/manager#7',
      title: 'Add cache',
      number: 7,
      githubUrl: 'https://github.com/Trackunit/manager/pull/7',
      sourceBranch: 'feature/cache',
      targetBranch: 'master',
    },
    head,
  );

  test('scopes the review to the PR diff', () => {
    expect(prompt).toContain('git diff origin/master...HEAD');
    expect(prompt).toContain('https://github.com/Trackunit/manager/pull/7');
  });

  test('pins the review to the head commit, fetching it from the PR ref for forks', () => {
    expect(prompt).toContain(`You are reviewing commit ${head}`);
    expect(prompt).toContain('git rev-parse HEAD');
    expect(prompt).toContain('git fetch origin pull/7/head');
    expect(prompt).toContain(`git checkout --detach ${head}`);
    expect(prompt).toContain('"reviewedSha"');
  });

  test('marks the title as untrusted author text', () => {
    expect(prompt).toMatch(/title .*written by the PR author.*not instructions/i);
  });

  test('forbids commits, pushes, PRs and approvals', () => {
    expect(prompt).toMatch(/never commit/i);
    expect(prompt).toMatch(/push/i);
    expect(prompt).toMatch(/pull request/i);
    expect(prompt).toMatch(/never approve/i);
  });

  test('asks for the JSON result in a json fence', () => {
    expect(prompt).toContain('```json');
    expect(prompt).toContain('"verdict": "approve" | "comment" | "requestChanges"');
  });
});
