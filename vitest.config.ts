import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', root: './packages/shared', environment: 'node' } },
      { test: { name: 'server', root: './apps/server', environment: 'node' } },
      { test: { name: 'web', root: './apps/web', environment: 'node' } },
      { test: { name: 'repo', root: './scripts', environment: 'node' } },
    ],
  },
});
