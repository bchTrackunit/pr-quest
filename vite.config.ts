import react from '@vitejs/plugin-react';
import type { PluginOptions as ReactCompilerOptions } from 'babel-plugin-react-compiler';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Logger, type Plugin } from 'vite';

import { loadConfig } from './src/platform/server/config.ts';

const config = loadConfig({
  legacyEnvFilePath: fileURLToPath(new URL('./.env.local', import.meta.url)),
});
const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * React Compiler options, plus a build-only plugin that reports how many components and hooks it
 * memoised and which ones it skipped. A skipped function still works; it just isn't memoised.
 */
function reactCompiler(): { options: ReactCompilerOptions; report: Plugin } {
  let compiled = 0;
  const skipped: Array<string> = [];
  let logger: Logger | undefined;
  return {
    options: {
      target: '19',
      logger: {
        logEvent(filename, event) {
          if (event.kind === 'CompileSuccess') {
            compiled += 1;
          } else if (event.kind === 'CompileError' || event.kind === 'PipelineError') {
            const reason = event.kind === 'CompileError' ? event.detail.reason : event.data;
            const file = filename === null ? 'unknown file' : relative(root, filename);
            skipped.push(`${file}:${event.fnLoc?.start.line ?? '?'} ${reason}`);
          }
        },
      },
    },
    report: {
      name: 'react-compiler-report',
      apply: 'build',
      configResolved(resolved) {
        logger = resolved.logger;
      },
      buildEnd() {
        logger?.info(`React Compiler: memoised ${compiled}, skipped ${skipped.length}`);
        for (const entry of skipped) {
          logger?.warn(`  skipped ${entry}`);
        }
      },
    },
  };
}

const compiler = reactCompiler();

export default defineConfig({
  root,
  plugins: [
    react({ babel: { plugins: [['babel-plugin-react-compiler', compiler.options]] } }),
    compiler.report,
  ],
  server: {
    host: config.host,
    port: config.uiPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://${config.host}:${config.port}`,
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
  },
});
