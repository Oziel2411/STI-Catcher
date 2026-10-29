# STI-Catcher

Web app interna (inspirada en aTube Catcher) para **descargar video por URL**, **grabar pantalla** desde el navegador y **convertir archivos**, con historial. Corre en una PC con Windows 10 que hace de servidor en la red interna; los compañeros la usan desde el navegador, sin login.

- Especificación completa: [SPEC.md](SPEC.md). Decisiones vigentes y su porqué: [docs/DECISIONS.md](docs/DECISIONS.md).
- Plataforma única: Windows. Sin Docker, Linux ni macOS.

## Estado

| Fase | Contenido                                                                    | Estado    |
| ---- | ---------------------------------------------------------------------------- | --------- |
| 0    | Plan                                                                         | ✅        |
| 1    | Esqueleto: monorepo, config, logs, `/api/health`, página Estado, `setup.ps1` | ✅        |
| 2    | Jobs + DB + SSE                                                              | pendiente |
| 3    | Descarga por URL                                                             | pendiente |
| 4    | Historial                                                                    | pendiente |
| 5    | Conversión                                                                   | pendiente |
| 6    | Grabación de pantalla                                                        | pendiente |
| 7    | Despliegue                                                                   | pendiente |

Se trabaja de a una fase: tests + commit + resumen, y **esperar el OK** antes de la siguiente.

## Comandos

```bash
.\scripts\setup.ps1 -AllowUserNode   # primera vez en una PC de desarrollo (binarios, .env, carpetas)
npm install
npm run dev          # server (tsx watch, :3000) + web (Vite, http://127.0.0.1:5173)
npm run build        # web (apps/web/dist) + server (apps/server/dist)
npm start            # producción: un proceso, un puerto (requiere NODE_ENV=production en .env)
npm test             # Vitest, todos los proyectos
npm run lint         # ESLint (con tipos)
npm run typecheck    # tsc por workspace
npm run format       # Prettier
npm run check        # typecheck + lint + format:check + test (correr antes de cada commit)
```

## Estructura

- `apps/server` — Fastify. Capas: `routes/` (HTTP) → `modules/` (lógica, no conoce Fastify) → `adapters/` (procesos, disco, DB). `http/` tiene helpers HTTP (errores, validación).
- `apps/web` — React + Vite. `features/<sección>/`, `components/`, `api/` (cliente tipado).
- `packages/shared` — esquemas Zod del contrato de API (y presets en la Fase 5). Se consume como código TS, sin build.
- `scripts/` — PowerShell (`setup.ps1`, …). `bin/`, `storage/`, `data/`, `logs/` están en `.gitignore`.

## Convenciones

- Código, identificadores y commits en **inglés** ([Conventional Commits](https://www.conventionalcommits.org/)). UI, comentarios de dominio y documentación en **español**.
- TypeScript `strict` + `noUncheckedIndexedAccess`. Imports relativos con extensión `.ts`.
- Todo input HTTP se valida con Zod (`parseInput` en `apps/server/src/http/validation.ts`). Los errores de la API tienen el formato `ApiError` de shared, con `message` en español apto para el usuario y sin rutas ni detalles internos.
- Procesos hijos: solo `spawn` con array de argumentos, `shell: false`. Matar con `killProcessTree` (taskkill /T /F). ESLint prohíbe `exec`/`execSync`.
- `modules/` no puede importar Fastify (regla de ESLint).
- Los adapters se inyectan como funciones y se mockean en los tests. Los tests no acceden a la red.
- Tests junto al código (`*.test.ts`); fixtures reales en `apps/server/test/fixtures/`.
- Scripts `.ps1`: UTF-8 **con BOM** y CRLF (PowerShell 5.1). Hay un test que lo verifica.
- Configuración solo desde `.env` (validado con Zod al arrancar). Nada de rutas fijas en el código.

## Decisiones vigentes (resumen)

Detalle en `docs/DECISIONS.md`.

- Binarios (yt-dlp, ffmpeg, ffprobe, deno) en `BIN_DIR`, descargados por `setup.ps1` con verificación SHA-256. Deno siempre `BIN_DIR\deno.exe`, pasado a yt-dlp con `--js-runtimes deno:<ruta>`.
- yt-dlp con `--use-extractors default,-generic` por defecto; el bloqueo de IPs privadas es una segunda capa.
- Servicio de Windows con **WinSW 2.12** y cuenta virtual `NT SERVICE\sti-catcher` (no LocalSystem).
- HTTPS ⇒ HTTP/2 con fallback a HTTP/1.1. Sin HTTPS solo se escucha en localhost.
- SSE: un event bus; `/api/events` (stream único por pestaña) y `/api/jobs/:id/events` son filtros sobre él.
- TypeScript fijado en 6.0.x (typescript-eslint no soporta 7).
