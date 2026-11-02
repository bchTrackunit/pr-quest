/**
 * Moves files from the old single-package layout (`src/<layer>/{server,ui}/`) into the workspace
 * packages (`apps/server`, `apps/web`, `packages/contract`) and repairs the relative paths that
 * the move broke. Run it with `node scripts/restructure.ts`.
 *
 * It is safe to run again: on a branch that has merged the new layout, it moves the files the
 * branch still has under `src/` and repairs the relative paths that no longer resolve. A path is
 * only rewritten when it is broken where the file now is and its target, resolved from where the
 * file used to be, exists at its new location. Paths it can't repair are listed, not guessed.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Rule {
  from: RegExp;
  to: string;
}

/**
 * Old path to new path, in order; the first match wins. `$1` is the feature name. `src/desktop/`
 * is the Electron app on the desktop branches; `apps/desktop` needs its own package.json there.
 */
const MOVES: ReadonlyArray<Rule> = [
  { from: /^index\.html$/, to: 'apps/web/index.html' },
  { from: /^vite\.config\.ts$/, to: 'apps/web/vite.config.ts' },
  { from: /^src\/app\/server\/main\.ts$/, to: 'apps/server/src/main.ts' },
  { from: /^src\/app\/ui\/main\.tsx$/, to: 'apps/web/src/main.tsx' },
  { from: /^src\/app\/server\//, to: 'apps/server/src/app/' },
  { from: /^src\/app\/ui\//, to: 'apps/web/src/app/' },
  { from: /^src\/platform\/server\//, to: 'apps/server/src/platform/' },
  { from: /^src\/platform\/ui\//, to: 'apps/web/src/platform/' },
  { from: /^src\/features\/([^/]+)\/server\//, to: 'apps/server/src/features/$1/' },
  { from: /^src\/features\/([^/]+)\/ui\//, to: 'apps/web/src/features/$1/' },
  { from: /^src\/shared\//, to: 'packages/contract/src/' },
  { from: /^src\/desktop\//, to: 'apps/desktop/src/' },
];

/** New path to old path, for finding where a moved file used to be. */
const INVERSE: ReadonlyArray<Rule> = [
  { from: /^apps\/web\/index\.html$/, to: 'index.html' },
  { from: /^apps\/web\/vite\.config\.ts$/, to: 'vite.config.ts' },
  { from: /^apps\/server\/src\/main\.ts$/, to: 'src/app/server/main.ts' },
  { from: /^apps\/web\/src\/main\.tsx$/, to: 'src/app/ui/main.tsx' },
  { from: /^apps\/server\/src\/app\//, to: 'src/app/server/' },
  { from: /^apps\/web\/src\/app\//, to: 'src/app/ui/' },
  { from: /^apps\/server\/src\/platform\//, to: 'src/platform/server/' },
  { from: /^apps\/web\/src\/platform\//, to: 'src/platform/ui/' },
  { from: /^apps\/server\/src\/features\/([^/]+)\//, to: 'src/features/$1/server/' },
  { from: /^apps\/web\/src\/features\/([^/]+)\//, to: 'src/features/$1/ui/' },
  { from: /^packages\/contract\/src\//, to: 'src/shared/' },
  { from: /^apps\/desktop\/src\//, to: 'src/desktop/' },
];

/**
 * The string literal of an import, export, `vi.mock` and friends, or `new URL(…, import.meta.url)`.
 * A `vi` call's type argument sits in a lookbehind, so a `typeof import('…')` inside it still
 * matches on its own.
 */
const SPECIFIER =
  /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|(?<=\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)(?:<[^>]*>)?)\(\s*|\bnew URL\(\s*)(['"`])(\.{1,2}\/[^'"`$]*)/g;

/** An old `src/…` path in Markdown, such as a link target or a path in backticks. */
const MARKDOWN_PATH = /(?<![\w/.-])src\/[\w./-]*[\w/-]/g;

const root = fileURLToPath(new URL('..', import.meta.url));
const toPosix = (path: string): string => path.split(sep).join('/');
const unrepaired: Array<string> = [];

function apply(rules: ReadonlyArray<Rule>, path: string): string | undefined {
  for (const rule of rules) {
    if (rule.from.test(path)) {
      return path.replace(rule.from, rule.to);
    }
  }
  return undefined;
}

/** `apps/server`, `packages/contract`, or undefined outside a package. */
function packageOf(path: string): string | undefined {
  return /^((?:apps|packages)\/[^/]+)\//.exec(path)?.[1];
}

function git(...args: Array<string>): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

const lines = (output: string): Array<string> => output.split('\n').filter((line) => line !== '');

function moveFiles(): number {
  const unmerged = lines(git('diff', '--name-only', '--diff-filter=U', '--', 'src'));
  if (unmerged.length > 0) {
    throw new Error(`Resolve the merge conflicts under src/ first:\n${unmerged.join('\n')}`);
  }
  const listed = new Set(
    [
      ...lines(git('ls-files', '--cached', '--others', '--exclude-standard', '--', 'src')),
      'index.html',
      'vite.config.ts',
    ].filter((path) => existsSync(join(root, path))),
  );
  const tracked = new Set(lines(git('ls-files', '--', 'src', 'index.html', 'vite.config.ts')));
  let moved = 0;
  for (const from of listed) {
    const to = apply(MOVES, from);
    if (to === undefined) {
      process.stderr.write(`no rule for ${from}; move it by hand\n`);
      continue;
    }
    if (existsSync(join(root, to))) {
      process.stderr.write(`${to} already exists; merge ${from} into it by hand\n`);
      continue;
    }
    mkdirSync(dirname(join(root, to)), { recursive: true });
    if (tracked.has(from)) {
      git('mv', from, to);
    } else {
      renameSync(join(root, from), join(root, to));
    }
    moved += 1;
  }
  return moved;
}

function filesUnder(dir: string, keep: (path: string) => boolean): Array<string> {
  if (!existsSync(join(root, dir))) {
    return [];
  }
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => toPosix(relative(root, join(entry.parentPath, entry.name))))
    .filter((path) => !path.includes('node_modules/') && keep(path));
}

/**
 * How `importer` should refer to `target`: a relative path inside its package, or the package
 * name for a module in `packages/*`. Undefined when neither works, such as a file in another app or
 * a `new URL()` path, which can't take a package name.
 */
function specifierFor(
  importer: string,
  target: string,
  keepsTrailingSlash: boolean,
  isUrl: boolean,
): string | undefined {
  const targetPackage = packageOf(target);
  if (targetPackage !== undefined && targetPackage !== packageOf(importer)) {
    if (isUrl || !targetPackage.startsWith('packages/') || !/\.tsx?$/.test(target)) {
      return undefined;
    }
    const subpath = target.slice(`${targetPackage}/src/`.length).replace(/\.tsx?$/, '');
    return `@pr-quest/${targetPackage.slice('packages/'.length)}/${subpath}`;
  }
  const path = posix.relative(posix.dirname(importer), target) + (keepsTrailingSlash ? '/' : '');
  return path.startsWith('.') ? path : `./${path}`;
}

function repairSpecifier(importer: string, specifier: string, isUrl: boolean): string | undefined {
  const resolvedHere = posix.normalize(posix.join(posix.dirname(importer), specifier));
  if (existsSync(join(root, resolvedHere))) {
    return undefined;
  }
  const oldImporter = apply(INVERSE, importer);
  if (oldImporter === undefined) {
    return undefined;
  }
  const oldTarget = posix.normalize(posix.join(posix.dirname(oldImporter), specifier));
  const newTarget = apply(MOVES, oldTarget);
  if (newTarget === undefined || !existsSync(join(root, newTarget))) {
    return undefined;
  }
  const repaired = specifierFor(
    importer,
    newTarget.replace(/\/$/, ''),
    specifier.endsWith('/'),
    isUrl,
  );
  if (repaired === undefined) {
    unrepaired.push(`${importer}: '${specifier}' now points into ${newTarget}`);
  }
  return repaired;
}

function repairSource(path: string): boolean {
  const text = readFileSync(join(root, path), 'utf8');
  const next = text.replace(
    SPECIFIER,
    (match, prefix: string, quote: string, specifier: string) => {
      const repaired = repairSpecifier(path, specifier, prefix.startsWith('new URL'));
      return repaired === undefined ? match : `${prefix}${quote}${repaired}`;
    },
  );
  if (next === text) {
    return false;
  }
  writeFileSync(join(root, path), next);
  return true;
}

function repairMarkdown(path: string): boolean {
  const text = readFileSync(join(root, path), 'utf8');
  const next = text.replace(MARKDOWN_PATH, (match: string) => {
    const moved = apply(MOVES, match);
    return moved !== undefined && existsSync(join(root, moved.replace(/\/$/, ''))) ? moved : match;
  });
  if (next === text) {
    return false;
  }
  writeFileSync(join(root, path), next);
  return true;
}

const movedCount = moveFiles();
const sources = ['apps', 'packages'].flatMap((dir) =>
  filesUnder(dir, (path) => /\.(?:ts|tsx|html)$/.test(path)),
);
const sourceCount = sources.filter(repairSource).length;
const markdownCount = ['README.md', ...filesUnder('docs', (path) => path.endsWith('.md'))].filter(
  (path) => existsSync(join(root, path)) && repairMarkdown(path),
).length;
for (const path of filesUnder('apps', (file) => file.endsWith('.html'))) {
  const text = readFileSync(join(root, path), 'utf8');
  const next = text.replace('src="/src/app/ui/main.tsx"', 'src="/src/main.tsx"');
  if (next !== text) {
    writeFileSync(join(root, path), next);
  }
}
process.stdout.write(
  `moved ${movedCount} files, repaired paths in ${sourceCount} source and ${markdownCount} Markdown files\n`,
);
for (const entry of unrepaired) {
  process.stderr.write(`fix by hand: ${entry}\n`);
}
if (filesUnder('src', () => true).length > 0) {
  process.stdout.write('src/ still has files the script has no rule for; see the messages above\n');
} else {
  rmSync(join(root, 'src'), { recursive: true, force: true });
}
