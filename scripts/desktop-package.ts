/*
 * Packages the desktop app for one target, by default this machine's:
 *
 *   node scripts/desktop-package.ts [--target <triple>] [--bundles <a,b>] [--skip-build] [--layout-only]
 *
 * 1. `yarn build`, then the sidecar layout and Node for the target (scripts/desktop/layout.ts).
 * 2. Signs the native code Tauri doesn't (scripts/desktop/sign.ts), when signing is configured.
 * 3. `tauri build` with what the environment adds to the config (scripts/desktop/config.ts).
 *    macOS bundles separately, retrying when hdiutil finds the dmg's volume busy.
 * 5. Linux: takes libwayland-client out of the AppImage (tauri-apps/tauri#15665).
 *
 * Bundles land in $CARGO_TARGET_DIR (default src-tauri/target)/<triple>/release/bundle/.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { configOverlay } from './desktop/config.ts';
import { layOut, SIDECAR_DIR } from './desktop/layout.ts';
import { signMacCode, signWindowsCode } from './desktop/sign.ts';
import { appImageLibrariesToStrip, hostTriple, targetFor, type Target } from './desktop/targets.ts';

const TAURI_CLI = join('node_modules', '@tauri-apps', 'cli', 'tauri.js');
const DMG_ATTEMPTS = 3;
/** From https://github.com/AppImage/appimagetool/releases/tag/1.9.1. */
const APPIMAGETOOL: Record<string, { url: string; sha256: string }> = {
  x86_64: {
    url: 'https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage',
    sha256: 'ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0',
  },
  aarch64: {
    url: 'https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-aarch64.AppImage',
    sha256: 'f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158',
  },
};

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
  stripAppImage();
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

function stripAppImage(): void {
  const dir = join(bundleDir, 'appimage');
  const name = readdirSync(dir).find((file) => file.endsWith('.AppImage'));
  if (name === undefined) {
    throw new Error(`No AppImage in ${dir}`);
  }
  const appImage = resolve(dir, name);
  const work = mkdtempSync(join(tmpdir(), 'pr-quest-appimage-'));
  try {
    run(appImage, ['--appimage-extract'], { cwd: work, stdio: 'ignore' });
    const root = join(work, 'squashfs-root');
    const lib = join(root, 'usr', 'lib');
    const strip = appImageLibrariesToStrip(readdirSync(lib));
    if (strip.length === 0) {
      log('the AppImage has no libwayland-client to take out');
      return;
    }
    for (const file of strip) {
      rmSync(join(lib, file));
    }
    const arch = target.triple.split('-')[0] ?? '';
    run(appImageTool(arch), ['--no-appstream', root, appImage], {
      env: { ...process.env, ARCH: arch, APPIMAGE_EXTRACT_AND_RUN: '1' },
    });
    log(`took ${strip.join(', ')} out of ${name}`);
    // The updater's signature was for the AppImage as Tauri made it.
    if (existsSync(`${appImage}.sig`)) {
      rmSync(`${appImage}.sig`);
      tauri(['signer', 'sign', appImage]);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function appImageTool(arch: string): string {
  const tool = APPIMAGETOOL[arch];
  if (tool === undefined) {
    throw new Error(`No appimagetool for ${arch}`);
  }
  const file = resolve('build-tauri', 'cache', `appimagetool-${arch}-1.9.1.AppImage`);
  mkdirSync(resolve('build-tauri', 'cache'), { recursive: true });
  if (!existsSync(file) || sha256(file) !== tool.sha256) {
    run('curl', ['--fail', '--location', '--silent', '--show-error', '--output', file, tool.url]);
  }
  if (sha256(file) !== tool.sha256) {
    rmSync(file, { force: true });
    throw new Error(`appimagetool doesn't have the pinned SHA-256 ${tool.sha256}`);
  }
  chmodSync(file, 0o755);
  return file;
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

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
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
