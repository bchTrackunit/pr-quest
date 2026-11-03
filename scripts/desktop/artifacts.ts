/* What scripts/desktop-package.ts makes, as scripts/desktop-smoke.ts finds and runs it. */
import { join } from 'node:path';

import { SIDECAR_NODE, type Os, type Target } from './targets.ts';

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

/**
 * What's wrong with the files next to the shell in a bundle (Contents/MacOS, /usr/bin or the
 * install folder), if anything: the sidecar must be there under its own name, and nothing may be
 * called `node`, which would shadow the system's Node on PATH.
 */
export function sidecarBinaryProblem(os: Os, files: ReadonlyArray<string>): string | undefined {
  const exe = os === 'windows' ? '.exe' : '';
  if (files.includes(`node${exe}`)) {
    return `the bundle has a node${exe} next to the shell, which would shadow the system's Node`;
  }
  if (!files.includes(`${SIDECAR_NODE}${exe}`)) {
    return `the bundle has no ${SIDECAR_NODE}${exe} next to the shell`;
  }
  return undefined;
}

/** The files a deb installs into /usr/bin, from `dpkg-deb -c`. */
export function debBinaries(listing: string): Array<string> {
  return listing
    .split('\n')
    .map((line) => /\.\/usr\/bin\/([^/]+)$/.exec(line.trim())?.[1])
    .filter((name) => name !== undefined);
}
