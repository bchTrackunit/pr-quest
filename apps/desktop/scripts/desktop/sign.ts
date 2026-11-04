/*
 * Code signing for what Tauri doesn't sign itself. Each step runs only when its environment
 * variable is set, so local and CI builds without secrets skip it.
 *
 * macOS (APPLE_SIGNING_IDENTITY): Tauri signs the app and the Node externalBin, but not the
 * native code among the resources: the Cursor SDK's tree-sitter bindings, cursorsandbox and rg.
 * Notarization rejects an app with any unsigned Mach-O inside, so they're signed here first.
 * Tauri signs Node with the app's entitlements (src-tauri/entitlements.plist), which replaces the
 * official binary's debugging ones.
 *
 * macOS without an identity: Tauri signs the app ad hoc, Node included, with the hardened runtime
 * and scripts/desktop/entitlements-ad-hoc.plist (scripts/desktop/config.ts), which replaces the
 * official binary's debugging entitlements such as get-task-allow. Ad-hoc code has no Team ID,
 * so Node keeps disable-library-validation to load the SDK's native modules.
 *
 * Windows (PR_QUEST_WINDOWS_SIGN_COMMAND): Tauri's signCommand covers the shell, the installer
 * and resources ending in .exe or .dll; the SDK's .node files are signed here.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

import { signCommandArgs } from './config.ts';
import { isMachO } from './targets.ts';

/** What a signed app's Node has: V8 compiles JavaScript at run time. */
const SIGNED_NODE_ENTITLEMENTS = ['com.apple.security.cs.allow-jit'];
/** What an ad-hoc signed app's Node has (scripts/desktop/entitlements-ad-hoc.plist). */
const AD_HOC_NODE_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.disable-library-validation',
];

export function signMacCode(identity: string, sidecarDir: string): number {
  if (identity === '-') {
    // Library validation needs Node and the modules it loads to share a Team ID; ad-hoc code has none.
    throw new Error(
      "An ad-hoc signed app can't load the Cursor SDK's native modules under the hardened " +
        'runtime; set APPLE_SIGNING_IDENTITY to a Developer ID, or leave it unset',
    );
  }
  const files = filesUnder(sidecarDir).filter((file) => isMachO(head(file)));
  for (const file of files) {
    execFileSync(
      'codesign',
      ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, file],
      { stdio: 'inherit' },
    );
  }
  return files.length;
}

/** The entitlements of a signed file, as codesign prints them in XML; empty when it has none. */
export function entitlementsOf(file: string): string {
  return execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** The flags of a file's code signature, as `codesign -d` prints them: `0x10002(adhoc,runtime)`. */
export function codeFlagsOf(file: string): string {
  // codesign prints the details on stderr.
  const { stderr } = spawnSync('codesign', ['-d', '--verbose=2', file], { encoding: 'utf8' });
  return /\bflags=(\S+)/.exec(stderr)?.[1] ?? '';
}

/**
 * What's wrong with the bundled Node's signature, if anything: it needs the hardened runtime,
 * which keeps debuggers and injected libraries out, and exactly the entitlements it runs with.
 */
export function nodeSignatureProblem(
  { entitlements, flags }: { entitlements: string; flags: string },
  signed: boolean,
): string | undefined {
  const wanted = signed ? SIGNED_NODE_ENTITLEMENTS : AD_HOC_NODE_ENTITLEMENTS;
  const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1] ?? '');
  const extra = keys.filter((key) => !wanted.includes(key));
  const missing = wanted.filter((key) => !keys.includes(key));
  const problems = [
    ...(/\(.*\bruntime\b.*\)/.test(flags)
      ? []
      : [`no hardened runtime (flags ${flags || 'none'})`]),
    ...(extra.length > 0 ? [`entitlements it must not have: ${extra.join(', ')}`] : []),
    ...(missing.length > 0 ? [`not the entitlements it needs: ${missing.join(', ')}`] : []),
  ];
  return problems.length === 0 ? undefined : `the bundled Node has ${problems.join('; ')}`;
}

export function signWindowsCode(template: string, sidecarDir: string): number {
  const files = filesUnder(sidecarDir).filter((file) =>
    ['.node', '.exe', '.dll'].includes(extname(file).toLowerCase()),
  );
  for (const file of files) {
    signWindowsFile(template, file);
  }
  return files.length;
}

export function signWindowsFile(template: string, file: string): void {
  const [command, ...args] = signCommandArgs(template, file);
  if (command === undefined) {
    throw new Error('PR_QUEST_WINDOWS_SIGN_COMMAND is empty');
  }
  execFileSync(command, args, { stdio: 'inherit' });
}

function filesUnder(dir: string): Array<string> {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((path) => join(dir, path))
    .filter((path) => lstatSync(path).isFile());
}

function head(file: string): Buffer {
  const buffer = Buffer.alloc(4);
  const fd = openSync(file, 'r');
  try {
    const read = readSync(fd, buffer, 0, 4, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}
