import { describe, expect, test } from 'vitest';

import { budgetDiff, splitDiff } from './diffBudget.ts';

function fileDiff(path: string, body = '@@ -1 +1 @@\n-old\n+new\n'): string {
  return `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n${body}`;
}

describe('splitDiff', () => {
  test('splits a unified diff into one block per file', () => {
    const diff = fileDiff('src/a.ts') + fileDiff('src/b.ts');

    expect(splitDiff(diff).map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(splitDiff(diff)[0]?.text).toBe(fileDiff('src/a.ts'));
  });

  test('names a deleted file by its old path', () => {
    const deleted =
      'diff --git a/old.ts b/old.ts\ndeleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n';

    expect(splitDiff(deleted)[0]?.path).toBe('old.ts');
  });

  test('names a renamed file without content changes by its new path', () => {
    const renamed =
      'diff --git a/a.ts b/b.ts\nsimilarity index 100%\nrename from a.ts\nrename to b.ts\n';

    expect(splitDiff(renamed)[0]?.path).toBe('b.ts');
  });

  test('ignores text before the first file', () => {
    expect(splitDiff(`garbage\n${fileDiff('a.ts')}`).map((file) => file.path)).toEqual(['a.ts']);
  });

  test('unquotes a path git quoted for a space and a quote', () => {
    const quoted =
      'diff --git "a/my \\"file\\".ts" "b/my \\"file\\".ts"\n--- "a/my \\"file\\".ts"\n+++ "b/my \\"file\\".ts"\n@@ -1 +1 @@\n-a\n+b\n';

    expect(splitDiff(quoted)[0]?.path).toBe('my "file".ts');
  });

  test('decodes a newline and a tab in a quoted path', () => {
    const quoted =
      'diff --git "a/x\\ny\\tz.ts" "b/x\\ny\\tz.ts"\n--- "a/x\\ny\\tz.ts"\n+++ "b/x\\ny\\tz.ts"\n@@ -1 +1 @@\n-a\n+b\n';

    expect(splitDiff(quoted)[0]?.path).toBe('x\ny\tz.ts');
  });

  test("decodes git's octal escapes of non-ASCII paths as UTF-8", () => {
    const quoted =
      'diff --git "a/caf\\303\\251/\\346\\227\\245.ts" "b/caf\\303\\251/\\346\\227\\245.ts"\n--- "a/caf\\303\\251/\\346\\227\\245.ts"\n+++ "b/caf\\303\\251/\\346\\227\\245.ts"\n@@ -1 +1 @@\n-a\n+b\n';

    expect(splitDiff(quoted)[0]?.path).toBe('café/日.ts');
  });

  test('decodes a quoted rename target', () => {
    const renamed =
      'diff --git a/a.ts "b/\\303\\251.ts"\nsimilarity index 100%\nrename from a.ts\nrename to "\\303\\251.ts"\n';

    expect(splitDiff(renamed)[0]?.path).toBe('é.ts');
  });
});

describe('budgetDiff', () => {
  test('keeps everything that fits', () => {
    const diff = fileDiff('src/a.ts') + fileDiff('src/b.ts');

    expect(budgetDiff(diff, { maxChars: 10_000 })).toEqual({
      text: diff,
      files: ['src/a.ts', 'src/b.ts'],
      omitted: [],
    });
  });

  test.each([
    ['yarn.lock', 'lockfile'],
    ['web/package-lock.json', 'lockfile'],
    ['pnpm-lock.yaml', 'lockfile'],
    ['go.sum', 'lockfile'],
    ['dist/bundle.js', 'generated'],
    ['libs/x/src/__generated__/types.ts', 'generated'],
    ['public/app.min.js', 'generated'],
    ['src/__snapshots__/a.test.ts.snap', 'generated'],
    ['api/service.pb.go', 'generated'],
  ])('leaves out %s as %s', (path, reason) => {
    const diff = fileDiff('src/a.ts') + fileDiff(path);

    const budgeted = budgetDiff(diff, { maxChars: 10_000 });

    expect(budgeted.omitted).toEqual([{ file: path, reason }]);
    expect(budgeted.text).toBe(fileDiff('src/a.ts'));
  });

  test.each(['src/build/plan.ts', 'packages/out/index.ts', 'apps/web/dist/main.ts'])(
    'reviews %s, because only a root dist, build or out folder is generated',
    (path) => {
      expect(budgetDiff(fileDiff(path), { maxChars: 10_000 }).omitted).toEqual([]);
    },
  );

  test.each(['build/app.js', 'out/index.js', 'web/node_modules/x/index.js', 'lib/vendor/y.go'])(
    'still leaves out %s as generated',
    (path) => {
      expect(budgetDiff(fileDiff(path), { maxChars: 10_000 }).omitted).toEqual([
        { file: path, reason: 'generated' },
      ]);
    },
  );

  test('leaves out binary files', () => {
    const binary =
      'diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n';

    expect(budgetDiff(binary, { maxChars: 10_000 }).omitted).toEqual([
      { file: 'logo.png', reason: 'binary' },
    ]);
  });

  test('skips files that no longer fit but still takes smaller ones after them', () => {
    const big = fileDiff('src/big.ts', `@@ -1 +1 @@\n+${'x'.repeat(500)}\n`);
    const small = fileDiff('src/small.ts');
    const first = fileDiff('src/first.ts');

    const budgeted = budgetDiff(first + big + small, {
      maxChars: first.length + small.length + 10,
    });

    expect(budgeted.files).toEqual(['src/first.ts', 'src/small.ts']);
    expect(budgeted.omitted).toEqual([{ file: 'src/big.ts', reason: 'tooLarge' }]);
    expect(budgeted.text).toBe(first + small);
  });
});
