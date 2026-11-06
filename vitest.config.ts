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
          // El primer test de cada archivo de rutas paga el arranque en frío de
          // Fastify y sus plugins (~300 ms sin carga). Con la PC ocupada (dev server
          // + decenas de workers de Vitest) se multiplica y rozaba los 5 s por defecto.
          // Los tests normales duran decenas de ms: el margen no esconde cuelgues reales.
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      { test: { name: 'web', root: './apps/web', environment: 'node' } },
      { test: { name: 'repo', root: './scripts', environment: 'node' } },
    ],
  },
});
