import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', root: './packages/shared', environment: 'node' } },
      {
        test: {
          name: 'server',
          root: './apps/server',
          environment: 'node',
          // El primer test de cada archivo de rutas levanta la app entera; en Windows,
          // en frío (después de cambiar archivos) puede pasar los 5 s por defecto.
          testTimeout: 15_000,
        },
      },
      { test: { name: 'web', root: './apps/web', environment: 'node' } },
      { test: { name: 'repo', root: './scripts', environment: 'node' } },
    ],
  },
});
