/* What scripts/desktop-package.ts makes, as scripts/desktop-smoke.ts finds and runs it. */
import { join } from 'node:path';

import type { Target } from './targets.ts';

export type ArtifactKind = 'app' | 'dmg' | 'appimage' | 'deb' | 'nsis' | 'executable';

export function artifactKind(path: string): ArtifactKind {
  const name = path.replace(/[/\\]+$/, '');
  if (name.endsWith('.app')) {
    return 'app';
  }
  if (name.endsWith('.dmg')) {
    return 'dmg';
  }
  if (name.endsWith('.AppImage')) {
    return 'appimage';
  }
  if (name.endsWith('.deb')) {
    return 'deb';
  }
  if (name.endsWith('-setup.exe')) {
    return 'nsis';
  }
  return 'executable';
}

const DEFAULT_BUNDLE: Record<Target['os'], { dir: string; suffix: string }> = {
  macos: { dir: 'macos', suffix: '.app' },
  linux: { dir: 'appimage', suffix: '.AppImage' },
  windows: { dir: 'nsis', suffix: '-setup.exe' },
};

/** The bundle a smoke test checks when it isn't given one, if packaging made it. */
export function defaultArtifact(
  target: Target,
  bundleDir: string,
  list: (dir: string) => Array<string>,
): string | undefined {
  const { dir, suffix } = DEFAULT_BUNDLE[target.os];
  const name = list(join(bundleDir, dir)).find((file) => file.endsWith(suffix));
  return name === undefined ? undefined : join(bundleDir, dir, name);
}
