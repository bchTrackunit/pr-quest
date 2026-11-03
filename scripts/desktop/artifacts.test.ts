import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';

import { artifactKind, defaultArtifact } from './artifacts.ts';
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
