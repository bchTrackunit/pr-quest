/*
 * Bundles the desktop main process into dist-desktop/. `PR_QUEST_RELEASE_BUILD=1` marks the bundle
 * as a release build (see src/desktop/buildFlags.ts), the only kind that checks for updates.
 * `PR_QUEST_RELEASE_REPO=owner/repo` names the repository it updates from and Help opens, in place
 * of the one in src/desktop/release.ts.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

import { releaseRepo } from '../src/desktop/release.ts';

const releaseBuild = process.env.PR_QUEST_RELEASE_BUILD === '1';
const releaseRepoOverride = process.env.PR_QUEST_RELEASE_REPO ?? '';
// Refuse a malformed value here rather than in the packaged app when it starts.
releaseRepo(releaseRepoOverride);

rmSync('dist-desktop', { recursive: true, force: true });
await build({
  entryPoints: ['src/desktop/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'dist-desktop/main.js',
  external: ['electron', 'electron-updater', '@cursor/sdk', '@anthropic-ai/sdk'],
  define: {
    __PR_QUEST_RELEASE_BUILD__: JSON.stringify(releaseBuild),
    __PR_QUEST_RELEASE_REPO__: JSON.stringify(releaseRepoOverride),
  },
  sourcemap: true,
  logLevel: 'warning',
});
