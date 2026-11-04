import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'apps/*',
      'packages/*',
      // The CI scripts, which belong to no package.
      { test: { name: 'ci', include: ['scripts/**/*.test.ts'], environment: 'node' } },
    ],
  },
});
