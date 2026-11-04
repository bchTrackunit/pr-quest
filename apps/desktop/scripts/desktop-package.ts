/*
 * Packages the desktop app for one target, by default this machine's:
 *
 *   node apps/desktop/scripts/desktop-package.ts [--target <triple>] [--bundles <a,b>] [--skip-build]
 *     [--layout-only | --compile-only | --skip-compile]
 *
 * Paths below are in apps/desktop/, and the script runs from any folder.
 * 1. `yarn build`, then the sidecar layout and Node for the target (scripts/desktop/layout.ts).
 * 2. `tauri build --no-bundle` with what the environment adds to the config
 *    (scripts/desktop/config.ts). --compile-only stops here, and leaves out every signing
 *    setting, so the release workflow compiles without its signing secrets.
 * 3. Signs the native code Tauri doesn't (scripts/desktop/sign.ts), when signing is configured.
 * 4. `tauri bundle`, which signs what Tauri signs; for macOS it retries when hdiutil finds the
 *    dmg's volume busy. --skip-compile starts here, with the binary, main.mjs and dist/ that
 *    --compile-only built, and lays out the sidecar's packages and Node again itself.
 * 5. Linux: makes sure the AppImage has no libwayland-client (scripts/desktop/appimage.ts).
 *
 * Bundles land in $CARGO_TARGET_DIR (default src-tauri/target)/<triple>/release/bundle/.
 */
import { execFileSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

import { stripAppImage } from './desktop/appimage.ts';
import { debBinaries, sidecarBinaryProblem } from './desktop/artifacts.ts';
import { configOverlay } from './desktop/config.ts';
import { layOut, layOutRuntime, SIDECAR_DIR } from './desktop/layout.ts';
import {
  BUILD_DIR,
  bundleDir as bundleDirFor,
  cargoTargetDir,
  DESKTOP_DIR,
  REPO_ROOT,
} from './desktop/paths.ts';
import {
  codeFlagsOf,
  entitlementsOf,
  nodeSignatureProblem,
  signMacCode,
  signWindowsCode,
} from './desktop/sign.ts';
import { hostTriple, targetFor, type Target } from './desktop/targets.ts';

const TAURI_CLI = createRequire(join(DESKTOP_DIR, 'package.json')).resolve(
  '@tauri-apps/cli/tauri.js',
);
/** Builds with the crate versions in Cargo.lock, which cargo-deny audited, or fails. */
const LOCKED = ['--', '--locked'];
const DMG_ATTEMPTS = 3;

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    bundles: { type: 'string' },
    'skip-build': { type: 'boolean', default: false },
    'layout-only': { type: 'boolean', default: false },
    'compile-only': { type: 'boolean', default: false },
    'skip-compile': { type: 'boolean', default: false },
  },
});
const modes = (['layout-only', 'compile-only', 'skip-compile'] as const).filter(
  (mode) => values[mode],
);
if (modes.length > 1) {
  throw new Error(`Pass only one of ${modes.map((mode) => `--${mode}`).join(', ')}`);
}
const target = targetFor(values.target ?? hostTriple(process.platform, process.arch));
const bundles = values.bundles?.split(',') ?? [
  ...target.bundles,
  ...(target.os === 'macos' ? ['dmg'] : []),
];
// Cargo, which tauri runs from src-tauri/, would read a relative one from there.
if ((process.env.CARGO_TARGET_DIR ?? '') !== '') {
  process.env.CARGO_TARGET_DIR = cargoTargetDir();
}
const bundleDir = bundleDirFor(target.triple);

const phase = values['compile-only'] ? 'compile' : values['skip-compile'] ? 'bundle' : 'all';
const { overlay, problems } = configOverlay(process.env, target, DESKTOP_DIR, phase);
if (problems.length > 0) {
  throw new Error(problems.join('\n'));
}
const configArgs: Array<string> = [];
if (Object.keys(overlay).length > 0) {
  const file = join(BUILD_DIR, `tauri.overlay.${phase}.json`);
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(file, `${JSON.stringify(overlay, null, 2)}\n`);
  configArgs.push('--config', file);
}

if (phase !== 'bundle') {
  if (!values['skip-build']) {
    // A command line, not yarn with arguments: Windows runs yarn.cmd only through a shell, which
    // would concatenate the arguments unescaped (DEP0190).
    execSync('yarn build', { cwd: REPO_ROOT, stdio: 'inherit' });
  }
  const node = await layOut(target);
  log(`laid out ${relative('.', SIDECAR_DIR)} and ${relative('.', node)} for ${target.triple}`);
  if (values['layout-only']) {
    process.exit(0);
  }
  tauri(['build', '--target', target.triple, '--no-bundle', ...configArgs, ...LOCKED]);
  if (phase === 'compile') {
    log(`compiled ${target.triple}; bundle it with --skip-compile`);
    process.exit(0);
  }
} else {
  if (!existsSync(join(bundleDir, '..', target.os === 'windows' ? 'pr-quest.exe' : 'pr-quest'))) {
    throw new Error(`Nothing compiled for ${target.triple}; run --compile-only first`);
  }
  // From this checkout's own node_modules and nodejs.org, not from whatever compiled the shell.
  const node = layOutRuntime(target);
  log(`laid out the sidecar's packages and ${relative('.', node)} for ${target.triple}`);
}

sign(target);
if (target.os === 'macos') {
  bundleMac(configArgs);
} else {
  tauri(['bundle', '--target', target.triple, '--bundles', bundles.join(','), ...configArgs]);
}
if (bundles.includes('appimage')) {
  stripLibraries();
}
checkBinaries();
for (const artifact of artifacts(bundleDir)) {
  log(`${relative('.', artifact.path)} (${(artifact.bytes / 1024 / 1024).toFixed(1)} MB)`);
}

function sign({ os }: Target): void {
  const identity = process.env.APPLE_SIGNING_IDENTITY ?? '';
  if (os === 'macos' && identity !== '') {
    log(`signed ${signMacCode(identity, SIDECAR_DIR)} Mach-O files`);
  }
  const template = process.env.PR_QUEST_WINDOWS_SIGN_COMMAND ?? '';
  if (os === 'windows' && template !== '') {
    log(`signed ${signWindowsCode(template, SIDECAR_DIR)} native files`);
  }
}

/**
 * `tauri bundle` deletes the bundles it isn't asked for, so the app and dmg go together.
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

/**
 * The app and the deb have the sidecar under its own name, and no `node` (see targets.ts), and
 * the app's Node runs under the hardened runtime with only the entitlements it needs.
 */
function checkBinaries(): void {
  const listings: Array<[string, Array<string>]> = [];
  const macos = join(bundleDir, 'macos', 'PR Quest.app', 'Contents', 'MacOS');
  if (target.os === 'macos' && existsSync(macos)) {
    listings.push([macos, readdirSync(macos)]);
    const bundledNode = join(macos, 'pr-quest-node');
    const signed = (process.env.APPLE_SIGNING_IDENTITY ?? '') !== '';
    const problem = existsSync(bundledNode)
      ? nodeSignatureProblem(
          { entitlements: entitlementsOf(bundledNode), flags: codeFlagsOf(bundledNode) },
          signed,
        )
      : undefined;
    if (problem !== undefined) {
      throw new Error(`${bundledNode}: ${problem}`);
    }
  }
  const debDir = join(bundleDir, 'deb');
  for (const deb of bundles.includes('deb') ? readdirSync(debDir) : []) {
    if (deb.endsWith('.deb')) {
      const listing = execFileSync('dpkg-deb', ['-c', join(debDir, deb)], { encoding: 'utf8' });
      listings.push([deb, debBinaries(listing)]);
    }
  }
  for (const [bundle, files] of listings) {
    const problem = sidecarBinaryProblem(target.os, files);
    if (problem !== undefined) {
      throw new Error(`${bundle}: ${problem}`);
    }
  }
}

/** tauri.conf.json takes its version from apps/desktop/package.json, as the app reports it. */
function appVersion(): string {
  return z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf8'))).version;
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
  run(process.execPath, [TAURI_CLI, ...args], { cwd: DESKTOP_DIR });
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
