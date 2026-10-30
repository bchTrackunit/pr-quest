import { z } from 'zod';

import type { Quest, ReviewFinding, ReviewResult } from '../shared/api.ts';

const MAX_FINDINGS = 200;
const MAX_TEXT_LENGTH = 20_000;

const VERDICT_ALIASES: Record<string, ReviewResult['verdict']> = {
  approve: 'approve',
  approved: 'approve',
  comment: 'comment',
  commented: 'comment',
  requestchanges: 'requestChanges',
  changesrequested: 'requestChanges',
};

const lowerCase = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** Lines that are not positive integers become file-level findings instead of failing the result. */
const toLine = (value: unknown): number | undefined => {
  const line = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof line === 'number' && Number.isInteger(line) && line >= 1 ? line : undefined;
};

const FindingSchema = z
  .object({
    file: z.string().trim().min(1).max(1000),
    line: z.unknown().transform(toLine).optional(),
    severity: z.preprocess(lowerCase, z.enum(['critical', 'major', 'minor', 'nit'])),
    body: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
  })
  .transform(({ line, ...rest }): ReviewFinding => (line === undefined ? rest : { ...rest, line }));

export const ReviewResultSchema = z.object({
  summary: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
  verdict: z.preprocess(
    (value) =>
      typeof value === 'string'
        ? (VERDICT_ALIASES[value.replace(/[^a-z]/gi, '').toLowerCase()] ?? value)
        : value,
    z.enum(['approve', 'comment', 'requestChanges']),
  ),
  findings: z.array(FindingSchema).max(MAX_FINDINGS),
});

export type ParsedReviewResult = { ok: true; result: ReviewResult } | { ok: false; error: string };

/** Reads the agent's final text: the last ```json fence, otherwise the last balanced JSON object. */
export function parseReviewResult(text: string | undefined): ParsedReviewResult {
  const value = text ? extractJson(text) : undefined;
  if (value === undefined) {
    return { ok: false, error: 'The agent did not return a JSON review result' };
  }
  const parsed = ReviewResultSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues.at(0);
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return {
      ok: false,
      error: `The agent's review JSON is invalid (${where}${issue?.message ?? 'unknown'})`,
    };
  }
  return { ok: true, result: parsed.data };
}

function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```json[ \t]*\r?\n([\s\S]*?)```/gi)];
  const lastFence = fences.at(-1)?.[1];
  if (lastFence !== undefined) {
    return tryJson(lastFence);
  }
  for (const candidate of balancedObjects(text).reverse()) {
    const value = tryJson(candidate);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Top-level `{...}` spans, skipping braces inside JSON strings. */
function balancedObjects(text: string): Array<string> {
  const spans: Array<string> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (depth > 0 && inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"' && depth > 0) {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth++;
    } else if (char === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        spans.push(text.slice(start, index + 1));
      }
    }
  }
  return spans;
}

export type ReviewTarget = Pick<
  Quest,
  'id' | 'title' | 'githubUrl' | 'sourceBranch' | 'targetBranch'
>;

/**
 * Cloud agents reject `systemPrompt` and tool restrictions, so the reviewer role and its limits
 * live in the prompt; `autoCreatePR: false` is the only hard guard.
 */
export function buildReviewPrompt(target: ReviewTarget): string {
  const diff = `git diff origin/${target.targetBranch}...HEAD`;
  return [
    'You are a senior code reviewer. You only read code and report findings.',
    '',
    `Pull request: ${target.id} "${target.title}"`,
    `URL: ${target.githubUrl}`,
    `You are on its source branch \`${target.sourceBranch}\`; it targets \`${target.targetBranch}\`.`,
    '',
    'Rules:',
    `- Review only the changes in \`${diff}\` (run \`git fetch origin ${target.targetBranch}\` first if needed). Read surrounding code only for context.`,
    '- Never commit, never push, never create branches, and never open or update a pull request.',
    '- Never approve the pull request and never post comments; the human decides what to post.',
    '- Do not modify files. If you run commands, they must be read-only.',
    '',
    'Look for, in priority order: correctness bugs, security problems (injection, secrets, authz), data loss,',
    'error handling gaps, performance problems, missing or weak tests, and maintainability issues.',
    'Severity: critical = must fix before merge (bug, security, data loss); major = should fix;',
    'minor = worth improving; nit = style or taste. Skip praise and do not repeat linter output.',
    'Use the line number in the new version of the file; omit `line` for file-level findings.',
    '',
    'Finish with only this JSON object in a ```json fence, and nothing after it:',
    '```json',
    '{',
    '  "summary": "2-4 sentences on what the PR does and its overall quality",',
    '  "verdict": "approve" | "comment" | "requestChanges",',
    '  "findings": [{ "file": "path/from/repo/root.ts", "line": 42, "severity": "critical" | "major" | "minor" | "nit", "body": "Markdown explaining the problem and a fix" }]',
    '}',
    '```',
  ].join('\n');
}
