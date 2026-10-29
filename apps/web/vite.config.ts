import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Lee PORT y HTTPS del mismo .env que el server, para que el proxy apunte bien.
 *
 * Se lee el archivo directamente y no con `loadEnv` de Vite, porque `loadEnv`
 * también toma las variables del sistema: una herramienta que define
 * `PORT=5173` para el propio Vite hacía que el proxy se apuntara a sí mismo
 * (medido: todas las llamadas a /api daban 502). Misma regla que el server (D-010).
 */
function readServerEnv(): Record<string, string | undefined> {
  const envFile = process.env.STI_ENV_FILE ?? path.join(repoRoot, '.env');
  try {
    return parseEnv(readFileSync(envFile, 'utf8'));
  } catch {
    return {};
  }
}

export default defineConfig(() => {
  const env = readServerEnv();
  const port = env.PORT?.trim() || '3000';
  const protocol = env.HTTPS_CERT_PATH?.trim() ? 'https' : 'http';

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: `${protocol}://127.0.0.1:${port}`,
          changeOrigin: true,
          // Certificado de mkcert/CA interna: válido en el navegador pero no para el proxy de Node.
          secure: false,
        },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
