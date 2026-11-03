import { describe, expect, it } from 'vitest';

import { configOverlay, signCommandArgs } from './config.ts';
import { targetFor } from './targets.ts';

const mac = targetFor('aarch64-apple-darwin');
const windows = targetFor('x86_64-pc-windows-msvc');
const PUBKEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IFJFQUwK';

describe('configOverlay', () => {
  it('changes nothing for a local build', () => {
    expect(configOverlay({}, mac, '/repo')).toEqual({ overlay: {}, problems: [] });
  });

  it('makes signed updater artifacts with the release key for a release build', () => {
    const { overlay, problems } = configOverlay(
      { PR_QUEST_RELEASE_BUILD: '1', PR_QUEST_UPDATER_PUBKEY: PUBKEY },
      mac,
      '/repo',
    );
    expect(problems).toEqual([]);
    expect(overlay).toEqual({
      bundle: { createUpdaterArtifacts: true },
      plugins: { updater: { pubkey: PUBKEY } },
    });
  });

  it('refuses a release build without its own updater key', () => {
    expect(configOverlay({ PR_QUEST_RELEASE_BUILD: '1' }, mac, '/repo').problems).toEqual([
      expect.stringMatching(/PR_QUEST_UPDATER_PUBKEY/),
    ]);
  });

  it('signs Windows binaries through the sign script when a sign command is set', () => {
    const { overlay } = configOverlay(
      { PR_QUEST_WINDOWS_SIGN_COMMAND: 'signtool sign /fd SHA256 %1' },
      windows,
      '/repo',
    );
    expect(overlay).toEqual({
      bundle: {
        windows: {
          signCommand: {
            cmd: process.execPath,
            args: ['/repo/scripts/sign-windows.ts', '%1'],
          },
        },
      },
    });
  });

  it('leaves the Windows sign command off other targets', () => {
    expect(
      configOverlay({ PR_QUEST_WINDOWS_SIGN_COMMAND: 'signtool sign %1' }, mac, '/repo').overlay,
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
