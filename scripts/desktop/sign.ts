/*
 * Code signing for what Tauri doesn't sign itself. Each step runs only when its environment
 * variable is set, so local and CI builds without secrets skip it.
 *
 * macOS (APPLE_SIGNING_IDENTITY): Tauri signs the app and the Node externalBin, but not the
 * native code among the resources: the Cursor SDK's tree-sitter bindings, cursorsandbox and rg.
 * Notarization rejects an app with any unsigned Mach-O inside, so they're signed here first.
 * Node is re-signed too: the official binary carries get-task-allow, which notarization refuses.
 *
 * Windows (PR_QUEST_WINDOWS_SIGN_COMMAND): Tauri's signCommand covers the shell, the installer
 * and resources ending in .exe or .dll; the SDK's .node files are signed here.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

import { signCommandArgs } from './config.ts';
import { isMachO } from './targets.ts';

/** The app's entitlements, which Node needs: V8 compiles JavaScript at run time. */
const ENTITLEMENTS = join('src-tauri', 'entitlements.plist');

export function signMacCode(identity: string, sidecarDir: string, node: string): number {
  if (identity === '-') {
    // Library validation needs Node and the modules it loads to share a Team ID; ad-hoc code has none.
    throw new Error(
      "An ad-hoc signed app can't load the Cursor SDK's native modules under the hardened " +
        'runtime; set APPLE_SIGNING_IDENTITY to a Developer ID, or leave it unset',
    );
  }
  const files = filesUnder(sidecarDir).filter((file) => isMachO(head(file)));
  for (const file of files) {
    codesign(identity, file, []);
  }
  codesign(identity, node, ['--entitlements', ENTITLEMENTS]);
  const entitlements = execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', node], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (entitlements.includes('get-task-allow')) {
    throw new Error(`${node} still has get-task-allow after signing`);
  }
  return files.length + 1;
}

function codesign(identity: string, file: string, extra: ReadonlyArray<string>): void {
  execFileSync(
    'codesign',
    ['--force', '--options', 'runtime', '--timestamp', ...extra, '--sign', identity, file],
    { stdio: 'inherit' },
  );
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
