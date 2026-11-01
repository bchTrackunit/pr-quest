/*
 * Bundles the desktop main process into dist-desktop/. `PR_QUEST_RELEASE_BUILD=1` marks the bundle
 * as a release build (see src/desktop/buildFlags.ts), the only kind that checks for updates.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const releaseBuild = process.env.PR_QUEST_RELEASE_BUILD === '1';

rmSync('dist-desktop', { recursive: true, force: true });
await build({
  entryPoints: ['src/desktop/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'dist-desktop/main.js',
  external: ['electron', 'electron-updater', '@cursor/sdk', '@anthropic-ai/sdk'],
  define: { __PR_QUEST_RELEASE_BUILD__: JSON.stringify(releaseBuild) },
  sourcemap: true,
  logLevel: 'warning',
});
