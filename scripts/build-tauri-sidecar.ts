/*
 * Lays out what the Tauri bundle ships next to the shell, after `yarn build`:
 * - build-tauri/sidecar/: the server bundled from src/desktop/sidecar/main.ts as main.mjs, the
 *   built UI in dist/, and the node_modules the bundle keeps external, the Cursor and Anthropic
 *   SDKs with their dependencies and only this machine's Cursor SDK platform package.
 * - src-tauri/binaries/node-<target triple>: the official Node binary, checked against a pinned
 *   SHA-256, which tauri.conf.json bundles as an externalBin.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';

/** The Node the sidecar runs on; keep it on the `volta` pin in package.json. */
const NODE_VERSION = '24.22.1';
/** From https://nodejs.org/dist/v24.22.1/SHASUMS256.txt. */
const NODE_ARCHIVES: Record<string, { triple: string; archive: string; sha256: string }> = {
  'darwin-arm64': {
    triple: 'aarch64-apple-darwin',
    archive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
  },
  'darwin-x64': {
    triple: 'x86_64-apple-darwin',
    archive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035',
  },
};
/** The SDKs the server bundle keeps external, as the Electron build does. */
const EXTERNAL = ['@cursor/sdk', '@anthropic-ai/sdk'];
const OUT = join('build-tauri', 'sidecar');
const ManifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
});
const CACHE = join('build-tauri', 'cache');

const platformKey = `${process.platform}-${process.arch}`;
const node = NODE_ARCHIVES[platformKey];
if (node === undefined) {
  throw new Error(`The Tauri spike only packages macOS so far, not ${platformKey}`);
}
if (!existsSync(join('dist', 'index.html'))) {
  throw new Error('No UI build in dist/; run `yarn build` first');
}

rmSync(OUT, { recursive: true, force: true });
await build({
  entryPoints: ['src/desktop/sidecar/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: join(OUT, 'main.mjs'),
  external: EXTERNAL,
  logLevel: 'warning',
});
cpSync('dist', join(OUT, 'dist'), { recursive: true, filter: (path) => !path.endsWith('.map') });
for (const dir of dependencyClosure(EXTERNAL)) {
  cpSync(dir, join(OUT, relative('.', dir)), {
    recursive: true,
    // Types, source maps and nested installs' links aren't needed at run time.
    filter: (path) => !/\.(map|d\.[cm]?ts)$/.test(path) && !path.includes(`node_modules/.bin`),
  });
}
writeFileSync(join(OUT, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);
installNode(node);
process.stdout.write(`Laid out ${OUT} and the Node ${NODE_VERSION} sidecar for ${node.triple}\n`);

/**
 * The package folders under node_modules that `roots` need at run time: their dependencies and
 * whichever optional ones Yarn installed, which for the Cursor SDK is only this platform's.
 */
function dependencyClosure(roots: ReadonlyArray<string>): Set<string> {
  const found = new Set<string>();
  const visit = (name: string, from: string, optional: boolean): void => {
    const dir = packageDir(name, from);
    if (dir === undefined) {
      if (optional) {
        return;
      }
      throw new Error(`${name}, needed by ${from}, isn't installed`);
    }
    if (found.has(dir)) {
      return;
    }
    found.add(dir);
    const manifest = ManifestSchema.parse(
      JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')),
    );
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      visit(dependency, dir, false);
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      visit(dependency, dir, true);
    }
    // Peers such as zod for the Anthropic SDK's helpers resolve from the app when it has them.
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      visit(dependency, dir, true);
    }
  };
  for (const root of roots) {
    visit(root, '.', false);
  }
  return found;
}

/** Where Node would resolve `name` from `from`, walking up node_modules folders. */
function packageDir(name: string, from: string): string | undefined {
  const require = createRequire(join(process.cwd(), from, 'noop.js'));
  const paths = require.resolve.paths(name) ?? [];
  for (const base of paths) {
    const dir = join(base, name);
    if (existsSync(join(dir, 'package.json'))) {
      return relative('.', dir);
    }
  }
  return undefined;
}

function installNode({
  triple,
  archive,
  sha256,
}: {
  triple: string;
  archive: string;
  sha256: string;
}): void {
  const target = join('src-tauri', 'binaries', `node-${triple}`);
  mkdirSync(CACHE, { recursive: true });
  const cached = join(CACHE, archive);
  if (!existsSync(cached) || hash(cached) !== sha256) {
    execFileSync('curl', [
      '--fail',
      '--location',
      '--silent',
      '--show-error',
      '--output',
      cached,
      `https://nodejs.org/dist/v${NODE_VERSION}/${archive}`,
    ]);
  }
  const actual = hash(cached);
  if (actual !== sha256) {
    rmSync(cached, { force: true });
    throw new Error(`${archive} has SHA-256 ${actual}, not the pinned ${sha256}`);
  }
  const extracted = join(CACHE, archive.replace(/\.tar\.gz$/, ''));
  rmSync(extracted, { recursive: true, force: true });
  execFileSync('tar', ['-xzf', cached, '-C', CACHE]);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(extracted, 'bin', 'node'), target);
  chmodSync(target, 0o755);
}

function hash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
