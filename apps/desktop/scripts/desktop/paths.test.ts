import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

import { BUILD_DIR, bundleDir, DESKTOP_DIR, REPO_ROOT, SRC_TAURI, WEB_DIST } from './paths.ts';

describe('paths', () => {
  test('point into the desktop package and the web app, wherever the script runs from', () => {
    expect(existsSync(join(DESKTOP_DIR, 'package.json'))).toBe(true);
    expect(existsSync(join(SRC_TAURI, 'tauri.conf.json'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'apps', 'web', 'package.json'))).toBe(true);
    expect(WEB_DIST).toBe(join(REPO_ROOT, 'apps', 'web', 'dist'));
    // tauri.conf.json bundles the sidecar from ../build-tauri/sidecar/.
    expect(BUILD_DIR).toBe(resolve(SRC_TAURI, '..', 'build-tauri'));
  });

  test("bundles land in src-tauri/target, or $CARGO_TARGET_DIR resolved from where it's set", () => {
    const bundle = join('aarch64-apple-darwin', 'release', 'bundle');
    expect(bundleDir('aarch64-apple-darwin', {})).toBe(join(SRC_TAURI, 'target', bundle));
    expect(bundleDir('aarch64-apple-darwin', { CARGO_TARGET_DIR: '/tmp/t' })).toBe(
      join('/tmp/t', bundle),
    );
    expect(bundleDir('aarch64-apple-darwin', { CARGO_TARGET_DIR: 'out' })).toBe(
      join(process.cwd(), 'out', bundle),
    );
  });
});
