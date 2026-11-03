import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';

import { artifactKind, debBinaries, defaultArtifact, sidecarBinaryProblem } from './artifacts.ts';
import { targetFor } from './targets.ts';

describe('artifactKind', () => {
  it('tells the bundles apart by name', () => {
    expect(artifactKind('bundle/macos/PR Quest.app')).toBe('app');
    expect(artifactKind('bundle/macos/PR Quest.app/')).toBe('app');
    expect(artifactKind('bundle/dmg/PR Quest_0.1.0_aarch64.dmg')).toBe('dmg');
    expect(artifactKind('bundle/appimage/PR Quest_0.1.0_amd64.AppImage')).toBe('appimage');
    expect(artifactKind('bundle/deb/PR Quest_0.1.0_amd64.deb')).toBe('deb');
    expect(artifactKind('bundle\\nsis\\PR Quest_0.1.0_x64-setup.exe')).toBe('nsis');
  });

  it('runs anything else as the executable it is', () => {
    expect(artifactKind('target/release/pr-quest')).toBe('executable');
    expect(artifactKind('C:\\Program Files\\PR Quest\\pr-quest.exe')).toBe('executable');
  });
});

describe('defaultArtifact', () => {
  const bundleDir = 'out/bundle';

  it('checks what players download: the app on macOS, the AppImage on Linux, the installer on Windows', () => {
    const listing = new Map([
      ['macos', ['PR Quest.app', 'PR Quest.app.tar.gz', 'PR Quest.app.tar.gz.sig']],
      ['appimage', ['PR Quest_0.1.0_amd64.AppImage', 'PR Quest_0.1.0_amd64.AppImage.sig']],
      ['nsis', ['PR Quest_0.1.0_x64-setup.exe', 'PR Quest_0.1.0_x64-setup.exe.sig']],
    ]);
    const list = (dir: string): Array<string> => listing.get(basename(dir)) ?? [];
    expect(defaultArtifact(targetFor('aarch64-apple-darwin'), bundleDir, list)).toBe(
      'out/bundle/macos/PR Quest.app',
    );
    expect(defaultArtifact(targetFor('x86_64-unknown-linux-gnu'), bundleDir, list)).toBe(
      'out/bundle/appimage/PR Quest_0.1.0_amd64.AppImage',
    );
    expect(defaultArtifact(targetFor('x86_64-pc-windows-msvc'), bundleDir, list)).toBe(
      'out/bundle/nsis/PR Quest_0.1.0_x64-setup.exe',
    );
  });

  it('has nothing to offer before packaging', () => {
    expect(defaultArtifact(targetFor('aarch64-apple-darwin'), bundleDir, () => [])).toBe(undefined);
  });
});

describe('sidecarBinaryProblem', () => {
  it('accepts the sidecar under its own name', () => {
    expect(sidecarBinaryProblem('linux', ['pr-quest', 'pr-quest-node'])).toBeUndefined();
    expect(sidecarBinaryProblem('windows', ['pr-quest.exe', 'pr-quest-node.exe'])).toBeUndefined();
  });

  it('refuses a bundle that would put a Node of its own on PATH as node', () => {
    expect(sidecarBinaryProblem('linux', ['pr-quest', 'node', 'pr-quest-node'])).toMatch(/node/);
    expect(sidecarBinaryProblem('windows', ['pr-quest.exe', 'node.exe'])).toMatch(/node\.exe/);
  });

  it('refuses a bundle without the sidecar', () => {
    expect(sidecarBinaryProblem('macos', ['pr-quest'])).toMatch(/pr-quest-node/);
  });
});

describe('debBinaries', () => {
  it('lists what the package installs into /usr/bin', () => {
    const listing = [
      'drwxr-xr-x root/root         0 2026-11-03 09:00 ./',
      'drwxr-xr-x root/root         0 2026-11-03 09:00 ./usr/bin/',
      '-rwxr-xr-x root/root  13000000 2026-11-03 09:00 ./usr/bin/pr-quest',
      '-rwxr-xr-x root/root 120000000 2026-11-03 09:00 ./usr/bin/pr-quest-node',
      '-rw-r--r-- root/root      1000 2026-11-03 09:00 ./usr/lib/PR Quest/sidecar/main.mjs',
    ].join('\n');
    expect(debBinaries(listing)).toEqual(['pr-quest', 'pr-quest-node']);
  });

  it("reads tauri's listing, whose paths have no ./", () => {
    const listing = [
      'drwxr-xr-x 0/0               0 2026-11-03 10:13 usr/bin',
      '-rwxr-xr-x 0/0         7412376 2026-11-03 10:13 usr/bin/pr-quest',
      '-rwxr-xr-x 0/0       123377224 2026-11-03 10:13 usr/bin/pr-quest-node',
      '-rw-r--r-- 0/0          985430 2026-11-03 10:13 usr/lib/PR Quest/sidecar/main.mjs',
    ].join('\n');
    expect(debBinaries(listing)).toEqual(['pr-quest', 'pr-quest-node']);
  });
});
