import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

import { loadConfig } from './src/platform/server/config.ts';

const config = loadConfig();

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
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
