import type {
  FindingSeverity,
  OmittedFile,
  OmittedFileReason,
  PostReviewEvent,
  ReviewFinding,
  ReviewProvider,
  ReviewVerdict,
} from '@pr-quest/contract/api';

/** What the player chose to post from a finished review run. */
export interface ReviewDraft {
  event: PostReviewEvent;
  summary: string;
  verdict: ReviewVerdict;
  findings: Array<ReviewFinding>;
  /** Who wrote the review, named in the footer. */
  provider: ReviewProvider;
  model?: string;
  /** Files the reviewer never saw, listed so other reviewers know to check them. */
  omitted?: Array<OmittedFile>;
  /** Commit the agent reviewed; anchors inline comments to that diff. */
  commitId?: string;
}

/** One of the `comments` of `POST /repos/{owner}/{repo}/pulls/{number}/reviews`. */
export interface GitHubReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  start_line?: number;
  start_side?: 'RIGHT';
  body: string;
}

/** A comment on a whole file, which only GraphQL can add to a review. */
export interface GitHubFileComment {
  path: string;
  body: string;
}

export interface RenderedFinding {
  /** Set when the finding has a line; GitHub still refuses lines outside the diff. */
  onLines?: GitHubReviewComment;
  /** The same finding on its file, for when it has no line GitHub accepts. */
  onFile: GitHubFileComment;
}

/** A review whose body never lists findings: each one is a comment on its lines or its file. */
export interface RenderedReview {
  event: 'COMMENT' | 'REQUEST_CHANGES';
  body: string;
  findings: Array<RenderedFinding>;
  commitId?: string;
}

const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
  nit: 'Nit',
};

const VERDICT_LABELS: Record<ReviewVerdict, string> = {
  approve: 'approve',
  comment: 'comment',
  requestChanges: 'request changes',
};

const PROVIDER_LABELS: Record<ReviewProvider, string> = {
  claude: 'Claude',
  cursor: 'a Cursor cloud review agent',
};

const OMITTED_REASON_LABELS: Record<OmittedFileReason, string> = {
  lockfile: 'lockfile',
  generated: 'generated',
  binary: 'binary',
  tooLarge: 'too large',
};

const MAX_OMITTED_LISTED = 50;
const MAX_OMITTED_NAME_LENGTH = 200;

/**
 * Renders a GitHub review. The body holds the summary, verdict and omitted files; findings are
 * only ever comments, with a suggested change when the reviewer wrote replacement code.
 */
export function renderReview(draft: ReviewDraft): RenderedReview {
  const review: RenderedReview = {
    event: draft.event === 'requestChanges' ? 'REQUEST_CHANGES' : 'COMMENT',
    body: renderBody(draft),
    findings: draft.findings.map(renderFinding),
  };
  if (draft.commitId) {
    review.commitId = draft.commitId;
  }
  return review;
}

function renderFinding(finding: ReviewFinding): RenderedFinding {
  const path = normalizePath(finding.file);
  const label = `**[${SEVERITY_LABELS[finding.severity]}]**`;
  const body = neutraliseMentions(finding.body.trim());
  const { suggestion } = finding;
  const line = validLine(finding.line);
  if (line === undefined) {
    return {
      onFile: {
        path,
        body: joinSections(
          `${label} ${body}`,
          suggestion === undefined ? undefined : `Suggested code:\n\n${codeBlock(suggestion)}`,
        ),
      },
    };
  }
  const start = validLine(finding.startLine);
  const startLine = start !== undefined && start < line ? start : undefined;
  const lines = startLine === undefined ? `line ${line}` : `lines ${startLine}-${line}`;
  const onLines: GitHubReviewComment = {
    path,
    line,
    side: 'RIGHT',
    body: joinSections(
      `${label} ${body}`,
      suggestion === undefined ? undefined : codeBlock(suggestion, 'suggestion'),
    ),
  };
  if (startLine !== undefined) {
    onLines.start_line = startLine;
    onLines.start_side = 'RIGHT';
  }
  return {
    onLines,
    onFile: {
      path,
      body: joinSections(
        `${label} On ${lines}: ${body}`,
        suggestion === undefined
          ? undefined
          : `Suggested code for ${lines}:\n\n${codeBlock(suggestion)}`,
      ),
    },
  };
}

function joinSections(...sections: Array<string | undefined>): string {
  return sections.filter((section) => section !== undefined).join('\n\n');
}

/** A fence longer than any backtick run in `code`, so the code can't close it early. */
function codeBlock(code: string, info = ''): string {
  const longestRun = Math.max(0, ...[...code.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${info}\n${code}\n${fence}`;
}

function renderBody(draft: ReviewDraft): string {
  const sections = [
    neutraliseMentions(draft.summary.trim()),
    `Agent verdict: ${VERDICT_LABELS[draft.verdict]} (advisory)`,
  ];
  if (draft.omitted && draft.omitted.length > 0) {
    sections.push(renderOmitted(draft.omitted));
  }
  sections.push(footer(draft));
  return sections.join('\n\n');
}

function renderOmitted(omitted: ReadonlyArray<OmittedFile>): string {
  const listed = omitted.slice(0, MAX_OMITTED_LISTED).map(({ file, reason }) => {
    const name =
      file.length > MAX_OMITTED_NAME_LENGTH ? `${file.slice(0, MAX_OMITTED_NAME_LENGTH)}…` : file;
    return `- ${codeSpan(name)} (${OMITTED_REASON_LABELS[reason]})`;
  });
  const unlisted = omitted.length - listed.length;
  return [
    'Not reviewed by the agent; check these yourself:',
    ...listed,
    ...(unlisted > 0 ? [`- and ${unlisted} more`] : []),
  ].join('\n');
}

function footer({ provider, model }: ReviewDraft): string {
  const by = model
    ? `${PROVIDER_LABELS[provider]} (${codeSpan(model)})`
    : PROVIDER_LABELS[provider];
  return `_Generated by ${by} through PR Quest._`;
}

/** Inline code that holds any text on one line: control characters become escapes. */
function codeSpan(text: string): string {
  const oneLine = text.replace(/\p{Cc}/gu, (char) => JSON.stringify(char).slice(1, -1));
  const longestRun = Math.max(0, ...[...oneLine.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const padding = oneLine.startsWith('`') || oneLine.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${oneLine}${padding}${fence}`;
}

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const MENTION_PATTERN = /(?<![\w@/])@[a-z\d][a-z\d-]*(?:\/[a-z\d](?:[\w.-]*[\w-])?)?/gi;

/**
 * Wraps `@user` and `@org/team` in inline code so model-written text posted as the player can't
 * notify anyone. Fenced blocks and code spans are left alone; GitHub never notifies from them.
 */
export function neutraliseMentions(markdown: string): string {
  return splitFences(markdown)
    .map(({ text, fenced }) => (fenced ? text : neutraliseProse(text)))
    .join('');
}

function splitFences(markdown: string): Array<{ text: string; fenced: boolean }> {
  const segments: Array<{ text: string; fenced: boolean }> = [];
  let open: string | undefined;
  for (const line of markdown.split(/(?<=\n)/)) {
    const fence = FENCE_PATTERN.exec(line)?.[1];
    const closes =
      open !== undefined && fence !== undefined && fence.startsWith(open) && line.trim() === fence;
    const fenced = open !== undefined || fence !== undefined;
    const last = segments.at(-1);
    if (last && last.fenced === fenced) {
      last.text += line;
    } else {
      segments.push({ text: line, fenced });
    }
    if (closes) {
      open = undefined;
    } else if (open === undefined && fence !== undefined) {
      open = fence;
    }
  }
  return segments;
}

/** A run of N backticks opens a code span only when a later run of exactly N closes it. */
function neutraliseProse(text: string): string {
  const runs = [...text.matchAll(/`+/g)].map((match) => ({
    start: match.index,
    length: match[0].length,
  }));
  const spans: Array<[number, number]> = [];
  const strayLengths = new Set<number>();
  for (let index = 0; index < runs.length; index += 1) {
    const opener = runs[index];
    if (!opener) {
      continue;
    }
    const closerIndex = runs.findIndex(
      (run, candidate) => candidate > index && run.length === opener.length,
    );
    const closer = runs[closerIndex];
    if (closer) {
      spans.push([opener.start, closer.start + closer.length]);
      index = closerIndex;
    } else {
      strayLengths.add(opener.length);
    }
  }
  let fenceLength = 1;
  while (strayLengths.has(fenceLength)) {
    fenceLength += 1;
  }
  const fence = '`'.repeat(fenceLength);
  return text.replace(MENTION_PATTERN, (mention: string, offset: number) => {
    if (spans.some(([start, end]) => offset >= start && offset < end)) {
      return mention;
    }
    const before = text.charAt(offset - 1) === '`' ? ' ' : '';
    const after = text.charAt(offset + mention.length) === '`' ? ' ' : '';
    return `${before}${fence}${mention}${fence}${after}`;
  });
}

function validLine(line: number | undefined): number | undefined {
  return line !== undefined && Number.isInteger(line) && line >= 1 ? line : undefined;
}

function normalizePath(file: string): string {
  return file.trim().replace(/^\.\//, '');
}
