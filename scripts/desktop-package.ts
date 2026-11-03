/*
 * Packages the desktop app for one target, by default this machine's:
 *
 *   node scripts/desktop-package.ts [--target <triple>] [--bundles <a,b>] [--skip-build] [--layout-only]
 *
 * 1. `yarn build`, then the sidecar layout and Node for the target (scripts/desktop/layout.ts).
 * 2. Signs the native code Tauri doesn't (scripts/desktop/sign.ts), when signing is configured.
 * 3. `tauri build` with what the environment adds to the config (scripts/desktop/config.ts).
 *    macOS bundles separately, retrying when hdiutil finds the dmg's volume busy.
 * 4. Linux: makes sure the AppImage has no libwayland-client (scripts/desktop/appimage.ts).
 *
 * Bundles land in $CARGO_TARGET_DIR (default src-tauri/target)/<triple>/release/bundle/.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

import { stripAppImage } from './desktop/appimage.ts';
import { configOverlay } from './desktop/config.ts';
import { layOut, SIDECAR_DIR } from './desktop/layout.ts';
import { signMacCode, signWindowsCode } from './desktop/sign.ts';
import { hostTriple, targetFor, type Target } from './desktop/targets.ts';

const TAURI_CLI = join('node_modules', '@tauri-apps', 'cli', 'tauri.js');
const DMG_ATTEMPTS = 3;

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    bundles: { type: 'string' },
    'skip-build': { type: 'boolean', default: false },
    'layout-only': { type: 'boolean', default: false },
  },
});
const target = targetFor(values.target ?? hostTriple(process.platform, process.arch));
const bundles = values.bundles?.split(',') ?? [
  ...target.bundles,
  ...(target.os === 'macos' ? ['dmg'] : []),
];
const repoRoot = process.cwd();
if (!existsSync(join(repoRoot, 'src-tauri', 'tauri.conf.json'))) {
  throw new Error('Run this from the repository root');
}

const { overlay, problems } = configOverlay(process.env, target, repoRoot);
if (problems.length > 0) {
  throw new Error(problems.join('\n'));
}
if (!values['skip-build']) {
  run('yarn', ['build'], { shell: process.platform === 'win32' });
}
const node = await layOut(target);
log(`laid out ${SIDECAR_DIR} and ${node} for ${target.triple}`);
if (values['layout-only']) {
  process.exit(0);
}

sign(target, node);

const configArgs: Array<string> = [];
if (Object.keys(overlay).length > 0) {
  const file = resolve('build-tauri', 'tauri.overlay.json');
  writeFileSync(file, `${JSON.stringify(overlay, null, 2)}\n`);
  configArgs.push('--config', file);
}
const bundleDir = join(
  process.env.CARGO_TARGET_DIR ?? join('src-tauri', 'target'),
  target.triple,
  'release',
  'bundle',
);
if (target.os === 'macos') {
  // `tauri bundle` deletes the bundles it isn't asked for, so the app and dmg go together.
  tauri(['build', '--target', target.triple, '--no-bundle', ...configArgs]);
  bundleMac(configArgs);
} else {
  tauri(['build', '--target', target.triple, '--bundles', bundles.join(','), ...configArgs]);
}
if (bundles.includes('appimage')) {
  stripLibraries();
}
for (const artifact of artifacts(bundleDir)) {
  log(`${artifact.path} (${(artifact.bytes / 1024 / 1024).toFixed(1)} MB)`);
}

function sign({ os }: Target, nodeBinary: string): void {
  const identity = process.env.APPLE_SIGNING_IDENTITY ?? '';
  if (os === 'macos' && identity !== '') {
    log(`signed ${signMacCode(identity, SIDECAR_DIR, nodeBinary)} Mach-O files`);
  }
  const template = process.env.PR_QUEST_WINDOWS_SIGN_COMMAND ?? '';
  if (os === 'windows' && template !== '') {
    log(`signed ${signWindowsCode(template, SIDECAR_DIR)} native files`);
  }
}

/**
 * hdiutil sometimes fails with "Resource busy" when Spotlight or a previous attempt still holds
 * the image; a stale mount of the volume then breaks every later attempt, so it goes first.
 */
function bundleMac(extraArgs: ReadonlyArray<string>): void {
  for (let attempt = 1; ; attempt += 1) {
    for (const volume of readdirSync('/Volumes').filter((name) => name.startsWith('PR Quest'))) {
      tryRun('hdiutil', ['detach', '-force', join('/Volumes', volume)]);
    }
    for (const dir of [join(bundleDir, 'macos'), join(bundleDir, 'dmg')]) {
      for (const leftover of existsSync(dir) ? readdirSync(dir) : []) {
        if (/^rw\..*\.dmg$/.test(leftover)) {
          rmSync(join(dir, leftover), { force: true });
        }
      }
    }
    try {
      tauri(['bundle', '--target', target.triple, '--bundles', bundles.join(','), ...extraArgs]);
      return;
    } catch (error) {
      if (attempt === DMG_ATTEMPTS || !bundles.includes('dmg')) {
        throw error;
      }
      log(`making the dmg failed (attempt ${attempt} of ${DMG_ATTEMPTS}); trying again`);
      execFileSync('sleep', ['5']);
    }
  }
}

function stripLibraries(): void {
  const dir = join(bundleDir, 'appimage');
  const name = readdirSync(dir).find((file) => file.endsWith('.AppImage'));
  if (name === undefined) {
    throw new Error(`No AppImage in ${dir}`);
  }
  // The app requires the version it was signed for, as Tauri's own signatures have it.
  const strip = stripAppImage(join(dir, name), target.triple.split('-')[0] ?? '', (file) => {
    tauri(['signer', 'sign', '--app-version', appVersion(), file]);
  });
  log(
    strip.length === 0
      ? 'the AppImage has no libwayland-client to take out'
      : `took ${strip.join(', ')} out of ${name}`,
  );
}

function appVersion(): string {
  const config = z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(join('src-tauri', 'tauri.conf.json'), 'utf8')));
  return config.version;
}

function artifacts(dir: string): Array<{ path: string; bytes: number }> {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).flatMap((kind) =>
    readdirSync(join(dir, kind))
      // The rest is what the bundler worked with.
      .filter((name) => /\.(app|dmg|tar\.gz|sig|AppImage|deb|exe)$/.test(name))
      .filter((name) => !name.startsWith('rw.'))
      .map((name) => join(dir, kind, name))
      .map((path) => ({ path, bytes: size(path) })),
  );
}

function size(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    return stat.size;
  }
  return readdirSync(path).reduce((total, name) => total + size(join(path, name)), 0);
}

function tauri(args: ReadonlyArray<string>): void {
  run(process.execPath, [TAURI_CLI, ...args]);
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  options: Parameters<typeof execFileSync>[2] = {},
): void {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function tryRun(command: string, args: ReadonlyArray<string>): void {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
}

function log(message: string): void {
  process.stdout.write(`[package] ${message}\n`);
}
