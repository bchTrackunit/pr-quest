import { Arch, type Configuration } from 'electron-builder';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { publishSettings, releaseRepo } from './src/desktop/release.ts';

/*
 * Installers for the desktop app. Local builds are unsigned. Release builds sign and publish
 * through the environment, which electron-builder reads itself:
 *
 * - macOS signing: CSC_LINK and CSC_KEY_PASSWORD, a Developer ID Application certificate.
 *   CSC_IDENTITY_AUTO_DISCOVERY=false skips signing even when a certificate is in the keychain.
 * - macOS notarization runs when signing and one of these is set: APPLE_API_KEY, APPLE_API_KEY_ID
 *   and APPLE_API_ISSUER (recommended), or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID.
 * - Windows signing with Azure Trusted Signing: the AZURE_SIGNING_* variables below, plus
 *   AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET for the service principal. Or an OV
 *   certificate with WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD instead.
 * - Release builds: PR_QUEST_RELEASE_BUILD=1, set for the whole `yarn desktop:package` so the
 *   bundle and this config agree. Only then does the build get publish settings and the
 *   app-update.yml the updater reads, and it refuses the placeholder RELEASE_REPO. Without it the
 *   app never checks for updates.
 * - Publishing: GH_TOKEN, used by `electron-builder --publish always`. Releases go to RELEASE_REPO
 *   in src/desktop/release.ts as drafts, or to the owner/repo in PR_QUEST_RELEASE_REPO, which
 *   like PR_QUEST_RELEASE_BUILD is set for the whole `yarn desktop:package`. The release workflow
 *   publishes from a job of its own instead; see RELEASING.md.
 */
const env = process.env;
const releaseBuild = env.PR_QUEST_RELEASE_BUILD === '1';
const repo = releaseRepo(env.PR_QUEST_RELEASE_REPO);

function required(name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required when AZURE_SIGNING_ENDPOINT is set`);
  }
  return value;
}

const azureSignOptions =
  env.AZURE_SIGNING_ENDPOINT === undefined
    ? undefined
    : {
        endpoint: env.AZURE_SIGNING_ENDPOINT,
        codeSigningAccountName: required('AZURE_SIGNING_ACCOUNT'),
        certificateProfileName: required('AZURE_SIGNING_PROFILE'),
        publisherName: required('AZURE_SIGNING_PUBLISHER'),
      };

// oxlint-disable-next-line no-template-curly-in-string -- electron-builder's own macro syntax
const artifactName = 'pr-quest-${version}-${os}-${arch}.${ext}';

const config: Configuration = {
  // The keychain entry, the user data folder and updates are tied to these; don't change them after
  // the first release.
  appId: 'com.prquest.desktop',
  productName: 'PR Quest',
  artifactName,
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*', 'dist-desktop/**/*', '!**/*.map', 'package.json'],
  // Native code can't load from inside app.asar, and the Cursor SDK starts programs from its
  // platform package's bin/ (cursorsandbox, rg) and loads tree-sitter from its vendor/, so those
  // stay unpacked.
  asarUnpack: [
    'node_modules/@cursor/sdk-*/bin/**',
    'node_modules/@cursor/sdk-*/vendor/**',
    '**/*.node',
  ],
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    // The UI comes from the local server, never from file:// URLs.
    grantFileProtocolExtraPrivileges: false,
    // Flipping fuses breaks the ad-hoc signature of an unsigned build, which Apple Silicon refuses
    // to run; a signed release build is signed again afterwards anyway.
    resetAdHocDarwinSignature: true,
  },
  beforePack: (context) => {
    // Yarn installs only the Cursor SDK binaries for the machine it runs on, so building another
    // architecture here would ship binaries that can't run there.
    const target = `${context.electronPlatformName}-${Arch[context.arch]}`;
    if (
      !existsSync(join(context.packager.projectDir, 'node_modules', '@cursor', `sdk-${target}`))
    ) {
      throw new Error(
        `node_modules has no @cursor/sdk-${target}, so a ${target} build couldn't run Cursor reviews. Build it on a ${target} machine.`,
      );
    }
  },
  publish: publishSettings({ releaseBuild, repo }),
  // A prerelease version like 1.1.0-beta.1 must not put a channel in app-update.yml: with a
  // channel, electron-updater installs older versions. CI checks the packaged file.
  detectUpdateChannel: false,
  // Targets name no architecture, so each build is for the machine it runs on unless `--arm64` or
  // `--x64` says otherwise. Release macOS on an Apple Silicon and an Intel runner.
  mac: {
    category: 'public.app-category.developer-tools',
    // A zip next to the dmg, because electron-updater updates macOS from the zip.
    target: ['dmg', 'zip'],
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
  },
  win: {
    target: ['nsis'],
    ...(azureSignOptions ? { azureSignOptions } : {}),
  },
  nsis: { oneClick: true, perMachine: false },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Development',
    executableName: 'pr-quest',
    maintainer: `PR Quest <${repo.owner}@users.noreply.github.com>`,
  },
};

export default config;
