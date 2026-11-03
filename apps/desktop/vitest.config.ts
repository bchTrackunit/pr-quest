import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'desktop',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
  },
});
