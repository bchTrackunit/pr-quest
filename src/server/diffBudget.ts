import type { OmittedFile } from '../shared/api.ts';

/** About 3.5 characters per token for code, so this keeps a diff near 120k tokens. */
export const DEFAULT_DIFF_BUDGET_CHARS = 420_000;

const LOCKFILES = new Set([
  'bun.lockb',
  'Cargo.lock',
  'composer.lock',
  'flake.lock',
  'Gemfile.lock',
  'go.sum',
  'gradle.lockfile',
  'mix.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'packages.lock.json',
  'Pipfile.lock',
  'pnpm-lock.yaml',
  'Podfile.lock',
  'poetry.lock',
  'pubspec.lock',
  'uv.lock',
  'yarn.lock',
]);

const GENERATED_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)(dist|build|out|vendor|node_modules|__generated__|generated)\//,
  /(^|\/)__snapshots__\//,
  /\.min\.(js|css|mjs)$/,
  /\.(map|snap)$/,
  /\.pb\.go$/,
  /_pb2(_grpc)?\.py$/,
  /\.g\.dart$/,
  /\.generated\.\w+$/,
  /\.designer\.cs$/,
];

export interface FileDiff {
  path: string;
  text: string;
}

export interface BudgetedDiff {
  /** The kept file diffs, in their original order. */
  text: string;
  files: Array<string>;
  omitted: Array<OmittedFile>;
}

/** One entry per `diff --git` block; anything before the first block is dropped. */
export function splitDiff(diff: string): Array<FileDiff> {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index);
  return starts.map((start, index) => {
    const text = diff.slice(start, starts[index + 1] ?? diff.length);
    return { path: pathOf(text), text };
  });
}

/**
 * Drops lockfiles, generated files and binaries, then keeps files in order while they fit in
 * `maxChars`. A file that doesn't fit is skipped, but smaller files after it still get in.
 */
export function budgetDiff(diff: string, options: { maxChars: number }): BudgetedDiff {
  const kept: Array<FileDiff> = [];
  const omitted: Array<OmittedFile> = [];
  let remaining = options.maxChars;
  for (const file of splitDiff(diff)) {
    const skipReason = classify(file);
    if (skipReason) {
      omitted.push({ file: file.path, reason: skipReason });
    } else if (file.text.length > remaining) {
      omitted.push({ file: file.path, reason: 'tooLarge' });
    } else {
      kept.push(file);
      remaining -= file.text.length;
    }
  }
  return {
    text: kept.map((file) => file.text).join(''),
    files: kept.map((file) => file.path),
    omitted,
  };
}

function classify(file: FileDiff): Exclude<OmittedFile['reason'], 'tooLarge'> | undefined {
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
  if (LOCKFILES.has(name)) {
    return 'lockfile';
  }
  if (GENERATED_PATTERNS.some((pattern) => pattern.test(file.path))) {
    return 'generated';
  }
  if (/^(Binary files .* differ|GIT binary patch)$/m.test(headerOf(file.text))) {
    return 'binary';
  }
  return undefined;
}

/** The lines before the first hunk, so added lines that look like headers can't confuse us. */
function headerOf(text: string): string {
  const hunk = text.search(/^@@ /m);
  return hunk === -1 ? text : text.slice(0, hunk);
}

function pathOf(text: string): string {
  const header = headerOf(text);
  const newPath = /^\+\+\+ (.+)$/m.exec(header)?.[1];
  if (newPath && newPath !== '/dev/null') {
    return stripPrefix(newPath, 'b/');
  }
  const oldPath = /^--- (.+)$/m.exec(header)?.[1];
  if (oldPath && oldPath !== '/dev/null') {
    return stripPrefix(oldPath, 'a/');
  }
  const renamedTo = /^rename to (.+)$/m.exec(header)?.[1];
  if (renamedTo) {
    return unquote(renamedTo);
  }
  const first = header.slice(0, header.indexOf('\n') === -1 ? undefined : header.indexOf('\n'));
  const bIndex = first.lastIndexOf(' b/');
  return bIndex === -1 ? first.replace(/^diff --git /, '') : unquote(first.slice(bIndex + 3));
}

function stripPrefix(path: string, prefix: string): string {
  const unquoted = unquote(path);
  return unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : unquoted;
}

/** Git quotes paths with unusual characters in C style. */
function unquote(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const value: unknown = JSON.parse(trimmed);
      return typeof value === 'string' ? value : trimmed.slice(1, -1);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
