import react from '@vitejs/plugin-react';
import type { PluginOptions as ReactCompilerOptions } from 'babel-plugin-react-compiler';
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { defineConfig, type Logger, type Plugin } from 'vite';

import { readPorts, SERVER_HOST } from '@pr-quest/contract/ports';

const root = fileURLToPath(new URL('.', import.meta.url));

/** The same `.env.local` the server reads, so both agree on the ports; the environment wins. */
const envFilePath = fileURLToPath(new URL('../../.env.local', import.meta.url));
const fileEnv = existsSync(envFilePath) ? parseEnv(readFileSync(envFilePath, 'utf8')) : {};
const ports = readPorts((name) => process.env[name] ?? fileEnv[name]);

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
    host: SERVER_HOST,
    port: ports.uiPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://${SERVER_HOST}:${ports.port}`,
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
  },
});
