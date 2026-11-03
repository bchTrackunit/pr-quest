/*
 * Lays out what the Tauri bundle ships next to the shell, after `yarn build` (paths in
 * apps/desktop/):
 * - build-tauri/sidecar/: the server bundled from src/sidecar/main.ts as main.mjs, the UI built
 *   into apps/web/dist/ as dist/, and the node_modules the bundle keeps external, the Cursor and
 *   Anthropic SDKs with their dependencies and only the target's Cursor SDK platform package.
 * - src-tauri/binaries/pr-quest-node-<target triple>: the official Node binary, checked against a pinned
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
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';

import { BUILD_DIR, DESKTOP_DIR, REPO_ROOT, SRC_TAURI, WEB_DIST } from './paths.ts';
import { NODE_VERSION, platformPackageProblem, type Target } from './targets.ts';

export const SIDECAR_DIR = join(BUILD_DIR, 'sidecar');
const CACHE = join(BUILD_DIR, 'cache');
/** The SDKs the server bundle keeps external: they load native code and data files at run time. */
const EXTERNAL = ['@cursor/sdk', '@anthropic-ai/sdk'];
const ManifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
});

/** Lays out the sidecar for `target` and returns the path of its Node binary. */
export async function layOut(target: Target): Promise<string> {
  if (!existsSync(join(WEB_DIST, 'index.html'))) {
    throw new Error(`No UI build in ${WEB_DIST}; run \`yarn build\` first`);
  }
  rmSync(SIDECAR_DIR, { recursive: true, force: true });
  await build({
    entryPoints: [join(DESKTOP_DIR, 'src', 'sidecar', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile: join(SIDECAR_DIR, 'main.mjs'),
    external: EXTERNAL,
    logLevel: 'warning',
  });
  cpSync(WEB_DIST, join(SIDECAR_DIR, 'dist'), {
    recursive: true,
    filter: (path) => !path.endsWith('.map'),
  });
  for (const dir of dependencyClosure(EXTERNAL, target)) {
    cpSync(dir, join(SIDECAR_DIR, installedPath(dir)), {
      recursive: true,
      // Types, source maps and nested installs' links aren't needed at run time.
      filter: (path) => !/\.(map|d\.[cm]?ts)$/.test(path) && !path.includes(`node_modules/.bin`),
    });
  }
  const scope = join(SIDECAR_DIR, 'node_modules', '@cursor');
  const problem = platformPackageProblem(
    readdirSync(scope).map((name) => `@cursor/${name}`),
    target,
  );
  if (problem !== undefined) {
    throw new Error(problem);
  }
  writeFileSync(join(SIDECAR_DIR, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);
  return installNode(target);
}

/**
 * The package folders under node_modules that `roots` need at run time: their dependencies and
 * the optional ones that are installed, of the Cursor SDK's platform packages only the target's.
 */
function dependencyClosure(roots: ReadonlyArray<string>, target: Target): Set<string> {
  const found = new Set<string>();
  const visit = (name: string, from: string, optional: boolean): void => {
    if (name.startsWith('@cursor/sdk-') && name !== target.sdkPackage) {
      return;
    }
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
    visit(root, DESKTOP_DIR, false);
  }
  return found;
}

/** Where Node would resolve `name` from the folder `from`, walking up node_modules folders. */
function packageDir(name: string, from: string): string | undefined {
  const require = createRequire(join(from, 'noop.js'));
  const paths = require.resolve.paths(name) ?? [];
  for (const base of paths) {
    const dir = join(base, name);
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
  }
  return undefined;
}

/**
 * `dir`'s path from the folder whose node_modules it is in, such as `node_modules/@cursor/sdk`:
 * the desktop package's own, or the repository root's, where Yarn hoists the rest.
 */
function installedPath(dir: string): string {
  return relative(dir.startsWith(`${DESKTOP_DIR}${sep}`) ? DESKTOP_DIR : REPO_ROOT, dir);
}

function installNode({ node, nodeBinary, os }: Target): string {
  const target = join(SRC_TAURI, 'binaries', nodeBinary);
  mkdirSync(CACHE, { recursive: true });
  const cached = join(CACHE, node.archive);
  if (!existsSync(cached) || hash(cached) !== node.sha256) {
    execFileSync('curl', [
      '--fail',
      '--location',
      '--silent',
      '--show-error',
      '--output',
      cached,
      `https://nodejs.org/dist/v${NODE_VERSION}/${node.archive}`,
    ]);
  }
  const actual = hash(cached);
  if (actual !== node.sha256) {
    rmSync(cached, { force: true });
    throw new Error(`${node.archive} has SHA-256 ${actual}, not the pinned ${node.sha256}`);
  }
  const zip = node.archive.endsWith('.zip');
  const extracted = join(CACHE, node.archive.replace(/\.(tar\.gz|zip)$/, ''));
  rmSync(extracted, { recursive: true, force: true });
  if (zip && process.platform === 'linux') {
    execFileSync('unzip', ['-q', cached, '-d', CACHE]);
  } else {
    // bsdtar, which macOS and Windows have as tar, reads zip files too.
    execFileSync('tar', ['-xf', cached, '-C', CACHE]);
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(extracted, os === 'windows' ? 'node.exe' : join('bin', 'node')), target);
  chmodSync(target, 0o755);
  return target;
}

function hash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
