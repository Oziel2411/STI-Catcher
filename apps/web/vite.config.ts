import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  // Lee PORT y HTTPS del mismo .env que el server, para que el proxy apunte bien.
  const env = loadEnv(mode, repoRoot, '');
  const port = env.PORT ?? '3000';
  const protocol = env.HTTPS_CERT_PATH ? 'https' : 'http';

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
