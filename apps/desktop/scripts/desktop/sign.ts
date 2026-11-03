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
 * macOS without an identity: Tauri signs nothing, so Node would keep the official binary's
 * entitlements, get-task-allow and disable-library-validation among them. It is signed ad hoc
 * without any instead; without the hardened runtime V8 needs none.
 *
 * Windows (PR_QUEST_WINDOWS_SIGN_COMMAND): Tauri's signCommand covers the shell, the installer
 * and resources ending in .exe or .dll; the SDK's .node files are signed here.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

import { signCommandArgs } from './config.ts';
import { isMachO } from './targets.ts';

/** What a signed app's Node may have: V8 compiles JavaScript at run time. */
const SIGNED_NODE_ENTITLEMENTS = ['com.apple.security.cs.allow-jit'];

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

/** Replaces the official Node binary's signature and entitlements with an ad-hoc one. */
export function adHocSignNode(node: string): void {
  execFileSync('codesign', ['--force', '--sign', '-', node], { stdio: 'inherit' });
}

/** The entitlements of a signed file, as codesign prints them in XML; empty when it has none. */
export function entitlementsOf(file: string): string {
  return execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** What's wrong with the bundled Node's entitlements, if anything. */
export function nodeEntitlementsProblem(xml: string, signed: boolean): string | undefined {
  const allowed = signed ? SIGNED_NODE_ENTITLEMENTS : [];
  const extra = [...xml.matchAll(/<key>([^<]+)<\/key>/g)]
    .map((match) => match[1] ?? '')
    .filter((key) => !allowed.includes(key));
  return extra.length === 0
    ? undefined
    : `the bundled Node has entitlements it must not have: ${extra.join(', ')}`;
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
