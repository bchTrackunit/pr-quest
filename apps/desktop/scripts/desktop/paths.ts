/*
 * Where the desktop app's parts are. The scripts run from anywhere, usually the repository root
 * through `just`, so these are absolute; a path given on the command line resolves from the cwd.
 */
import { join, resolve } from 'node:path';

/** apps/desktop, the @pr-quest/desktop package. */
export const DESKTOP_DIR = resolve(import.meta.dirname, '..', '..');
export const REPO_ROOT = resolve(DESKTOP_DIR, '..', '..');
export const SRC_TAURI = join(DESKTOP_DIR, 'src-tauri');
/** What the scripts lay out and cache; tauri.conf.json bundles `../build-tauri/sidecar/`. */
export const BUILD_DIR = join(DESKTOP_DIR, 'build-tauri');
/** The UI that `yarn build` makes, which the sidecar serves. */
export const WEB_DIST = join(REPO_ROOT, 'apps', 'web', 'dist');

/** Where Tauri puts the bundles for `triple`: under $CARGO_TARGET_DIR, or src-tauri/target. */
export function bundleDir(
  triple: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return join(cargoTargetDir(env), triple, 'release', 'bundle');
}

/** $CARGO_TARGET_DIR resolved from the cwd, or src-tauri/target. */
export function cargoTargetDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const set = env.CARGO_TARGET_DIR ?? '';
  return set === '' ? join(SRC_TAURI, 'target') : resolve(set);
}
