# STI-Catcher

Web app interna (inspirada en aTube Catcher) para **descargar video por URL**, **grabar pantalla** desde el navegador y **convertir archivos**, con historial. Corre en una PC con Windows 10 que hace de servidor en la red interna; los compañeros la usan desde el navegador, sin login.

- Especificación completa: [SPEC.md](SPEC.md). Decisiones vigentes y su porqué: [docs/DECISIONS.md](docs/DECISIONS.md).
- Plataforma única: Windows. Sin Docker, Linux ni macOS.

## Estado

| Fase | Contenido                                                                    | Estado                                  |
| ---- | ---------------------------------------------------------------------------- | --------------------------------------- |
| 0    | Plan                                                                         | ✅                                      |
| 1    | Esqueleto: monorepo, config, logs, `/api/health`, página Estado, `setup.ps1` | ✅                                      |
| 2    | Jobs + DB + SSE                                                              | ✅                                      |
| 3    | Descarga por URL                                                             | ✅                                      |
| 4    | Historial                                                                    | ✅                                      |
| 5    | Conversión                                                                   | ✅                                      |
| 6    | Grabación de pantalla                                                        | ✅                                      |
| 7    | Despliegue                                                                   | ✅ (falta instalar en el servidor real) |

Se trabaja de a una fase: tests + commit + resumen, y **esperar el OK** antes de la siguiente.

## Comandos

```bash
.\scripts\setup.ps1 -AllowUserNode   # primera vez en una PC de desarrollo (binarios, .env, carpetas)
.\scripts\update-ytdlp.ps1           # actualizar yt-dlp (rutina; no hace falta detener nada)
.\scripts\new-certificate.ps1        # certificado HTTPS con mkcert (servidor; ver docs/DEPLOY.md)
.\scripts\install-service.ps1        # servicio + permisos + firewall (admin; -DryRun simula)
.\scripts\uninstall-service.ps1      # quita servicio y regla de firewall (admin)
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

- `apps/server` — Fastify. Capas: `routes/` (HTTP) → `modules/` (lógica de cada función, no conoce Fastify) → `adapters/` (procesos, ffmpeg, disco, archivos).
  - `jobs/` — cola, estados, event bus, SSE, recuperación al arrancar. No conoce Fastify.
  - `db/` — conexión SQLite, migraciones (`migrations.ts`, se agregan al final, nunca se editan), repositorios.
  - `http/` — helpers HTTP (errores, `parseInput`). `test/` — helpers de tests (`makeTestApp`) y fixtures.
- `apps/web` — React + Vite. `features/<sección>/`, `components/`, `api/` (cliente HTTP + SSE tipado, con reconexión), `lib/` (formato y lógica pura).
- `packages/shared` — esquemas Zod del contrato de API y presets de conversión (`presets/conversion.ts`, lista cerrada). Se consume como código TS, sin build.
- `scripts/` — PowerShell: `setup.ps1`, `update-ytdlp.ps1`, `new-certificate.ps1`, `install-service.ps1`, `uninstall-service.ps1` y `common.ps1` (funciones compartidas). Instalación en el servidor: `docs/DEPLOY.md`. `service/` (WinSW + XML generado) va en `.gitignore`. `bin/`, `storage/`, `data/`, `logs/` están en `.gitignore`.

## Convenciones

- Código, identificadores y commits en **inglés** ([Conventional Commits](https://www.conventionalcommits.org/)). UI, comentarios de dominio y documentación en **español**.
- TypeScript `strict` + `noUncheckedIndexedAccess`. Imports relativos con extensión `.ts`.
- Todo input HTTP se valida con Zod (`parseInput` en `apps/server/src/http/validation.ts`). Los errores de la API tienen el formato `ApiError` de shared, con `message` en español apto para el usuario y sin rutas ni detalles internos.
- Procesos hijos: solo `spawn` con array de argumentos, `shell: false`. Matar con `killProcessTree` (taskkill /T /F). ESLint prohíbe `exec`/`execSync`.
- `modules/` y `jobs/` no pueden importar Fastify (regla de ESLint).
- Trabajo pesado = job: crear responde `202 { jobId }` y el progreso llega por SSE. Un runner nuevo implementa `JobRunner` (`jobs/types.ts`), escribe en `tempDir` solo archivos que empiezan con el id del job, corta sus procesos cuando se aborta `signal` y lanza `JobError` con un mensaje para el usuario cuando sabe qué falló.
- Los adapters se inyectan como funciones y se mockean en los tests. Los tests no acceden a la red.
- Tests junto al código (`*.test.ts`); fixtures reales en `apps/server/test/fixtures/` (ver su README: de dónde sale cada uno). Nunca inventar salidas de yt-dlp o ffprobe: capturarlas.
- Scripts `.ps1`: UTF-8 **con BOM** y CRLF (PowerShell 5.1). Hay un test que lo verifica.
- Configuración solo desde `.env` (validado con Zod al arrancar). Nada de rutas fijas en el código.

## Decisiones vigentes (resumen)

Detalle en `docs/DECISIONS.md`.

- Binarios (yt-dlp, ffmpeg, ffprobe, deno) en `BIN_DIR`, descargados por `setup.ps1` con verificación SHA-256. Deno siempre `BIN_DIR\deno.exe`, pasado a yt-dlp con `--js-runtimes deno:<ruta>`.
- yt-dlp con `--use-extractors default,-generic` por defecto; el bloqueo de IPs privadas es una segunda capa.
- Servicio de Windows con **WinSW 2.12** y cuenta virtual `NT SERVICE\sti-catcher` (no LocalSystem).
- HTTPS ⇒ HTTP/2 con fallback a HTTP/1.1. Sin HTTPS solo se escucha en localhost.
- SSE: un event bus; `/api/events` (stream único por pestaña) y `/api/jobs/:id/events` son filtros sobre él. Latido `event: ping` cada 10 s; el cliente reconecta si pasan 25 s sin nada.
- Una sola instancia por `DATA_DIR` (lock `sti-catcher.pid`). Al arrancar: matar huérfanos de `BIN_DIR`, vaciar `tmp`, running → failed "interrumpido", retomar queued.
- La cola borra los temporales de un job antes de publicar su estado final.
- Descarga: `-f bv[height<=H]+ba/b[height<=H]/bv+ba/b`; compat `-S vcodec:h264,res:H,channels:2,acodec:aac`. "Recodificar" lo hace nuestro ffmpeg (con progreso), no yt-dlp. Archivo en disco `<jobId>.<ext>`; el título solo va en `Content-Disposition`.
- `vite.config.ts` lee el `.env` directo (no `loadEnv`): una herramienta que define `PORT` apuntaba el proxy a sí mismo.
- Historial: cookie anónima `sti_client` (HttpOnly) → `isMine`; búsqueda sin tildes con `title_search`; un `done` sin archivo pasa a `expired` al mirarlo; borrar solo lo propio; reintentar = trabajo nuevo.
- Descarga + conversión encadenada (`then`): al terminar bien, la cola (`onDone`) crea la conversión por el camino normal y la vincula en `follow_up_job_id`; si las opciones no sirven, queda una conversión fallida con el motivo.
- Conversión: presets cerrados en shared → `buildConversionArgs` (pura); copia sin recodificar cuando el origen ya cumple; solo se ofrecen los presets que tienen sentido para el archivo (ffprobe); subida en streaming como `application/octet-stream`.
- Grabación: MediaRecorder en el navegador → fragmentos de 2 s numerados (`?seq=N`, reintento idempotente) a una **sesión** (tabla `recordings`, crudo en `STORAGE_DIR\recordings`, fuera de `tmp`). Al detener (o tras `RECORDING_IDLE_MINUTES` sin fragmentos) se crea el job `recording`, que deja MP4 H.264 + AAC (copia si ya cumple). Sin contexto seguro la página explica que hace falta HTTPS.
- Despliegue: WinSW 2.12 con XML generado por `install-service.ps1` (`stopparentprocessfirst`: Node corta los jobs antes que mueran sus hijos); ACLs con SIDs (Windows en español); certificado con mkcert, CA en el perfil del admin. Retención cada hora: archivos de jobs viejos → `expired`, huérfanos de `files/` y crudos de `recordings/`.
- UI: estilo Nocturne (`docs/design/nocturne/`, se aplica por etapas: D-090). Barra lateral (arriba en <760 px), botones primarios de contorno, Inter local (`@fontsource/inter` 400/500, nunca más grueso), íconos `@phosphor-icons/react` con nombres `*Icon`.
- TypeScript fijado en 6.0.x (typescript-eslint no soporta 7).

## API

| Método | Ruta                                                                       | Respuesta                                                                                                           |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                                                              | versiones, disco, trabajos (`?refresh=1` fuerza versiones)                                                          |
| GET    | `/api/jobs?status=a,b&type=x&limit=n`                                      | `{ jobs }`                                                                                                          |
| GET    | `/api/jobs/:id`                                                            | `{ job }`                                                                                                           |
| POST   | `/api/jobs/selftest` `{ durationSeconds? }`                                | 202 `{ jobId }` · 507 sin disco                                                                                     |
| POST   | `/api/jobs/:id/cancel`                                                     | 200 / 202 `{ job }` · 404 · 409                                                                                     |
| GET    | `/api/jobs/:id/events`                                                     | SSE de un job; se cierra al terminar                                                                                |
| GET    | `/api/events?jobIds=a,b`                                                   | SSE de varios jobs (o todos)                                                                                        |
| POST   | `/api/media/probe` `{ url }`                                               | título, resoluciones con codecs, `maxH264Height` · 400 URL inválida o interna · 422 error de yt-dlp traducido · 429 |
| POST   | `/api/jobs/download` `{ url, format, maxHeight, videoMode, title, then? }` | 202 `{ jobId }` · 400 · 507. `then: { preset, maxHeight?, gif? }` convierte al terminar (`followUpJobId`)           |
| GET    | `/api/jobs/:id/file`                                                       | el archivo (RFC 5987, Range) · 409 sin terminar · 410 ya no está                                                    |
| GET    | `/api/history?scope=all&q=…&page=n`                                        | `{ items (job + isMine), total, page, pageSize }`; `scope` es `mine` (por defecto) o `all`                          |
| DELETE | `/api/jobs/:id`                                                            | 204 · 403 no es tuyo · 409 en curso                                                                                 |
| POST   | `/api/jobs/:id/retry`                                                      | 202 `{ jobId }` (trabajo nuevo) · 409                                                                               |
| GET    | `/api/conversion/options`                                                  | topes del GIF y `maxUploadBytes`                                                                                    |
| POST   | `/api/uploads` (cuerpo binario, header `x-file-name`)                      | 201 `{ jobId }` (job `upload` terminado) · 413 · 415 · 422 · 507                                                    |
| GET    | `/api/conversion/sources/:id`                                              | `{ job, media, presets }` · 409 · 410                                                                               |
| POST   | `/api/jobs/convert` `{ sourceJobId, preset, maxHeight?, gif? }`            | 202 `{ jobId }` · 422 preset sin sentido o GIF inválido                                                             |
| POST   | `/api/recordings` `{ mimeType, fps, title }`                               | 201 `{ recordingId, maxChunkBytes }` · 507                                                                          |
| POST   | `/api/recordings/:id/chunks?seq=N` (cuerpo binario)                        | `{ nextSeq }` · 403 · 409 fuera de orden o cerrada · 413 · 415 · 507                                                |
| POST   | `/api/recordings/:id/finish`                                               | 202 `{ jobId }` (idempotente) · 409 vacía                                                                           |
