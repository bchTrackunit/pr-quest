/*
 * What a package build adds to tauri.conf.json from its environment, passed to `tauri build
 * --config`. Without any of these variables a build is a local one: no updater artifacts and
 * nothing signed but what Tauri does by default. A release build must be signed on macOS and
 * Windows.
 */
import { join } from 'node:path';

import type { Target } from './targets.ts';

export interface Overlay {
  overlay: Record<string, unknown>;
  problems: Array<string>;
}

export function configOverlay(
  env: Readonly<Record<string, string | undefined>>,
  target: Target,
  desktopDir: string,
): Overlay {
  const bundle: Record<string, unknown> = {};
  const plugins: Record<string, unknown> = {};
  const problems: Array<string> = [];
  if (env.PR_QUEST_RELEASE_BUILD === '1') {
    // tauri build signs them with TAURI_SIGNING_PRIVATE_KEY and fails without it.
    bundle.createUpdaterArtifacts = true;
    const pubkey = env.PR_QUEST_UPDATER_PUBKEY;
    if (pubkey === undefined || pubkey === '') {
      problems.push(
        'A release build needs PR_QUEST_UPDATER_PUBKEY, the public half of ' +
          'TAURI_SIGNING_PRIVATE_KEY; the key in tauri.conf.json is for local builds only',
      );
    } else {
      plugins.updater = { pubkey };
    }
    // Players install a release, so it must be signed where the OS checks.
    const identity = env.APPLE_SIGNING_IDENTITY ?? '';
    if (target.os === 'macos' && (identity === '' || identity === '-')) {
      problems.push('A macOS release build needs APPLE_SIGNING_IDENTITY, a Developer ID identity');
    }
    if (target.os === 'windows' && (env.PR_QUEST_WINDOWS_SIGN_COMMAND ?? '') === '') {
      problems.push('A Windows release build needs PR_QUEST_WINDOWS_SIGN_COMMAND');
    }
  }
  if (target.os === 'windows' && (env.PR_QUEST_WINDOWS_SIGN_COMMAND ?? '') !== '') {
    bundle.windows = {
      signCommand: {
        cmd: process.execPath,
        args: [join(desktopDir, 'scripts', 'sign-windows.ts'), '%1'],
      },
    };
  }
  const overlay: Record<string, unknown> = {};
  if (Object.keys(bundle).length > 0) {
    overlay.bundle = bundle;
  }
  if (Object.keys(plugins).length > 0) {
    overlay.plugins = plugins;
  }
  return { overlay, problems };
}

/**
 * `PR_QUEST_WINDOWS_SIGN_COMMAND` as argv for one file: split on spaces outside double quotes,
 * with `%1` standing for the file. No shell runs it, so a path with spaces stays one argument.
 */
export function signCommandArgs(template: string, file: string): Array<string> {
  const args: Array<string> = [];
  let current: string | undefined;
  let quoted = false;
  for (const char of template) {
    if (char === '"') {
      quoted = !quoted;
      current ??= '';
    } else if (char === ' ' && !quoted) {
      if (current !== undefined) {
        args.push(current);
        current = undefined;
      }
    } else {
      current = (current ?? '') + char;
    }
  }
  if (quoted) {
    throw new Error('PR_QUEST_WINDOWS_SIGN_COMMAND has an unclosed quote');
  }
  if (current !== undefined) {
    args.push(current);
  }
  if (!args.includes('%1')) {
    throw new Error('PR_QUEST_WINDOWS_SIGN_COMMAND needs %1 where the file to sign goes');
  }
  return args.map((arg) => (arg === '%1' ? file : arg));
}
