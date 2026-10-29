import { defineConfig } from 'tsup';

/**
 * Empaqueta el server en un único archivo para producción.
 * - `@sti-catcher/shared` se incluye en el bundle porque se publica como código TS.
 * - El resto de las dependencias quedan externas: pino carga sus transports
 *   (pino-roll) desde node_modules en un worker thread y no se puede empaquetar.
 */
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: ['@sti-catcher/shared'],
});
