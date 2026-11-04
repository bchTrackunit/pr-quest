import { describe, expect, it } from 'vitest';

import { configOverlay, signCommandArgs } from './config.ts';
import { targetFor } from './targets.ts';

const mac = targetFor('aarch64-apple-darwin');
const windows = targetFor('x86_64-pc-windows-msvc');
const linux = targetFor('x86_64-unknown-linux-gnu');
const IDENTITY = 'Developer ID Application: Octo Cat (ABCDE12345)';
const PUBKEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IFJFQUwK';
const AD_HOC = {
  macOS: {
    signingIdentity: '-',
    hardenedRuntime: true,
    entitlements: '/repo/apps/desktop/scripts/desktop/entitlements-ad-hoc.plist',
  },
};

describe('configOverlay', () => {
  it('changes nothing for a local Linux or Windows build', () => {
    expect(configOverlay({}, linux, '/repo/apps/desktop')).toEqual({ overlay: {}, problems: [] });
    expect(configOverlay({}, windows, '/repo/apps/desktop')).toEqual({ overlay: {}, problems: [] });
  });

  it('signs an unsigned macOS app ad hoc as a whole, with the hardened runtime', () => {
    for (const identity of [undefined, '']) {
      expect(
        configOverlay({ APPLE_SIGNING_IDENTITY: identity }, mac, '/repo/apps/desktop'),
      ).toEqual({
        overlay: { bundle: AD_HOC },
        problems: [],
      });
    }
  });

  it('leaves macOS signing to Tauri with a Developer ID', () => {
    expect(configOverlay({ APPLE_SIGNING_IDENTITY: IDENTITY }, mac, '/repo/apps/desktop')).toEqual({
      overlay: {},
      problems: [],
    });
  });

  it('trusts the release key in a release build, and makes signed update files only with the private key', () => {
    const release = { PR_QUEST_RELEASE_BUILD: '1', PR_QUEST_UPDATER_PUBKEY: PUBKEY };
    expect(configOverlay(release, linux, '/repo/apps/desktop')).toEqual({
      overlay: { plugins: { updater: { pubkey: PUBKEY } } },
      problems: [],
    });
    expect(
      configOverlay({ ...release, TAURI_SIGNING_PRIVATE_KEY: 'key' }, linux, '/repo/apps/desktop')
        .overlay,
    ).toEqual({
      bundle: { createUpdaterArtifacts: true },
      plugins: { updater: { pubkey: PUBKEY } },
    });
  });

  it('compiles a release build without any signing settings, which the bundle phase adds', () => {
    const release = { PR_QUEST_RELEASE_BUILD: '1', PR_QUEST_UPDATER_PUBKEY: PUBKEY };
    const trusted = { overlay: { plugins: { updater: { pubkey: PUBKEY } } }, problems: [] };
    expect(configOverlay(release, mac, '/repo/apps/desktop', 'compile')).toEqual(trusted);
    expect(
      configOverlay(
        { ...release, PR_QUEST_WINDOWS_SIGN_COMMAND: 'signtool sign %1' },
        windows,
        '/repo/apps/desktop',
        'compile',
      ),
    ).toEqual(trusted);
    expect(configOverlay(release, mac, '/repo/apps/desktop', 'bundle').problems).toEqual([
      expect.stringMatching(/APPLE_SIGNING_IDENTITY/),
    ]);
    expect(
      configOverlay({ PR_QUEST_RELEASE_BUILD: '1' }, mac, '/repo/apps/desktop', 'compile').problems,
    ).toEqual([expect.stringMatching(/PR_QUEST_UPDATER_PUBKEY/)]);
  });

  it('refuses a release build without its own updater key', () => {
    expect(
      configOverlay({ PR_QUEST_RELEASE_BUILD: '1' }, linux, '/repo/apps/desktop').problems,
    ).toEqual([expect.stringMatching(/PR_QUEST_UPDATER_PUBKEY/)]);
  });

  it('refuses an unsigned macOS release build', () => {
    const release = { PR_QUEST_RELEASE_BUILD: '1', PR_QUEST_UPDATER_PUBKEY: PUBKEY };
    for (const identity of [undefined, '', '-']) {
      expect(
        configOverlay({ ...release, APPLE_SIGNING_IDENTITY: identity }, mac, '/repo/apps/desktop')
          .problems,
      ).toEqual([expect.stringMatching(/APPLE_SIGNING_IDENTITY/)]);
    }
    expect(
      configOverlay({ ...release, APPLE_SIGNING_IDENTITY: IDENTITY }, mac, '/repo/apps/desktop')
        .problems,
    ).toEqual([]);
  });

  it('refuses an unsigned Windows release build', () => {
    const release = { PR_QUEST_RELEASE_BUILD: '1', PR_QUEST_UPDATER_PUBKEY: PUBKEY };
    expect(configOverlay(release, windows, '/repo/apps/desktop').problems).toEqual([
      expect.stringMatching(/PR_QUEST_WINDOWS_SIGN_COMMAND/),
    ]);
    expect(
      configOverlay(
        { ...release, PR_QUEST_WINDOWS_SIGN_COMMAND: 'signtool sign %1' },
        windows,
        '/repo/apps/desktop',
      ).problems,
    ).toEqual([]);
  });

  it('lets a release build skip code signing only when PR_QUEST_ALLOW_UNSIGNED_RELEASE is 1', () => {
    const dryRun = {
      PR_QUEST_RELEASE_BUILD: '1',
      PR_QUEST_UPDATER_PUBKEY: PUBKEY,
      PR_QUEST_ALLOW_UNSIGNED_RELEASE: '1',
    };
    expect(configOverlay(dryRun, mac, '/repo/apps/desktop')).toEqual({
      overlay: {
        bundle: AD_HOC,
        plugins: { updater: { pubkey: PUBKEY } },
      },
      problems: [],
    });
    expect(configOverlay(dryRun, windows, '/repo/apps/desktop').problems).toEqual([]);
    expect(configOverlay(dryRun, linux, '/repo/apps/desktop').problems).toEqual([]);
  });

  it('still needs the updater key when signing is skipped', () => {
    expect(
      configOverlay(
        { PR_QUEST_RELEASE_BUILD: '1', PR_QUEST_ALLOW_UNSIGNED_RELEASE: '1' },
        mac,
        '/repo/apps/desktop',
      ).problems,
    ).toEqual([expect.stringMatching(/PR_QUEST_UPDATER_PUBKEY/)]);
  });

  it('refuses PR_QUEST_ALLOW_UNSIGNED_RELEASE set to anything but 1, or outside a release build', () => {
    const release = { PR_QUEST_RELEASE_BUILD: '1', PR_QUEST_UPDATER_PUBKEY: PUBKEY };
    for (const value of ['true', 'yes', '0']) {
      expect(
        configOverlay(
          { ...release, PR_QUEST_ALLOW_UNSIGNED_RELEASE: value },
          linux,
          '/repo/apps/desktop',
        ).problems,
      ).toEqual([expect.stringMatching(/PR_QUEST_ALLOW_UNSIGNED_RELEASE/)]);
    }
    expect(
      configOverlay({ PR_QUEST_ALLOW_UNSIGNED_RELEASE: '1' }, linux, '/repo/apps/desktop').problems,
    ).toEqual([expect.stringMatching(/PR_QUEST_ALLOW_UNSIGNED_RELEASE/)]);
  });

  it('signs nothing on Linux, release or not', () => {
    expect(
      configOverlay({ APPLE_SIGNING_IDENTITY: IDENTITY }, linux, '/repo/apps/desktop').problems,
    ).toEqual([]);
  });

  it('signs Windows binaries through the sign script when a sign command is set', () => {
    const { overlay } = configOverlay(
      { PR_QUEST_WINDOWS_SIGN_COMMAND: 'signtool sign /fd SHA256 %1' },
      windows,
      '/repo/apps/desktop',
    );
    expect(overlay).toEqual({
      bundle: {
        windows: {
          signCommand: {
            cmd: process.execPath,
            args: ['/repo/apps/desktop/scripts/sign-windows.ts', '%1'],
          },
        },
      },
    });
  });

  it('leaves the Windows sign command off other targets', () => {
    expect(
      configOverlay(
        { PR_QUEST_WINDOWS_SIGN_COMMAND: 'signtool sign %1' },
        linux,
        '/repo/apps/desktop',
      ).overlay,
    ).toEqual({});
  });
});

describe('signCommandArgs', () => {
  it('puts the file where %1 is and keeps quoted arguments whole', () => {
    expect(
      signCommandArgs(
        'trusted-signing-cli -e https://weu.codesigning.azure.net -d "PR Quest" %1',
        'C:\\Temp\\PR Quest\\pr-quest.exe',
      ),
    ).toEqual([
      'trusted-signing-cli',
      '-e',
      'https://weu.codesigning.azure.net',
      '-d',
      'PR Quest',
      'C:\\Temp\\PR Quest\\pr-quest.exe',
    ]);
  });

  it('refuses a command without %1', () => {
    expect(() => signCommandArgs('signtool sign', 'a.exe')).toThrow(/%1/);
  });

  it('refuses an unclosed quote', () => {
    expect(() => signCommandArgs('signtool "sign %1', 'a.exe')).toThrow(/quote/);
  });
});
