# STI-Catcher — Especificación para Claude Code

## 0. Cómo quiero que trabajes

- Soy estudiante de programación. Sé TypeScript en profundidad. Cuando tomes una decisión que no sea obvia, explicá el porqué (en el resumen de la fase y en `docs/DECISIONS.md`).
- **No escribas código hasta que apruebe el plan de la Fase 0.**
- Trabajá por fases (sección 12). Al terminar cada una: corré los tests, hacé commit (Conventional Commits), resumí qué hiciste, cómo lo pruebo y qué decidiste. **Esperá mi OK antes de pasar a la siguiente.**
- Si algo de esta spec es técnicamente incorrecto, riesgoso o tiene una alternativa claramente mejor, decímelo antes de implementarlo. No la sigas a ciegas.
- Creá y mantené un `CLAUDE.md` con: objetivo del proyecto, comandos (dev, build, test, lint), convenciones y decisiones vigentes.
- Código, identificadores y commits en inglés. UI, comentarios de dominio y documentación en español.

## 1. Contexto y objetivo

Web app interna inspirada en aTube Catcher, con tres funciones:

1. **Descargar video por URL** (YouTube, Instagram, X, etc.), eligiendo resolución y formato. MP4 por defecto.
2. **Grabar pantalla** desde el navegador.
3. **Convertir archivos** entre formatos de video y audio.

Más un **historial** de todo lo procesado, con acceso directo a los archivos.

- Se desarrolla y prueba en mi PC. Destino final: una PC con **Windows 10** que funciona como servidor en la red interna del trabajo. Mis compañeros la usan desde el navegador de sus PCs.
- **Sin login.**
- El diseño apunta desde el día uno a ese servidor: nada de decisiones "solo para local" que haya que rehacer.
- Ubicación del repo: `D:\Documentos\Ozi\Proyectos\STI-Catcher` (la carpeta raíz se llama exactamente `STI-Catcher`).
- Plataforma única: Windows. No hace falta soportar Linux, macOS ni Docker.

## 2. Fuera de alcance (v1)

- Contenido protegido con DRM (Netflix, Disney+, Spotify, etc.): no se intenta descargar ni se implementa ningún tipo de evasión.
- Detección de streams en páginas web (modo "stream catcher" / extensión de navegador).
- Playlists completas: siempre `--no-playlist`.
- Usuarios, login, roles.
- Exposición a internet.

## 3. Stack y decisiones técnicas

Si alguna de estas decisiones te parece mala para este caso, argumentalo en la Fase 0 antes de cambiarla.

- **Node.js LTS actual + TypeScript** con `strict: true`.
- **Monorepo con npm workspaces:**
  - `apps/server`: backend.
  - `apps/web`: frontend.
  - `packages/shared`: esquemas Zod y tipos del contrato de API, y presets de conversión, compartidos entre server y web.
- **Backend:** Fastify. Validación de todo input con Zod.
- **Frontend:** React + Vite + TypeScript. UI en español. En producción el server sirve el build estático del frontend: un solo proceso y un solo puerto.
- **Persistencia:** SQLite con `better-sqlite3` y migraciones versionadas.
- **Motor de descarga:** ejecutable oficial `yt-dlp.exe`, más `ffmpeg` y `ffprobe`. Nunca reimplementar la extracción de sitios.
  - Desde la versión 2025.11.12, yt-dlp necesita un runtime de JavaScript externo para soportar YouTube completo.
  - Usar **Deno**: es el recomendado por yt-dlp y el único habilitado por defecto.
  - El ejecutable oficial ya incluye el componente `yt-dlp-ejs`. No instalar yt-dlp por pip.
- **Progreso en tiempo real:** Server-Sent Events. No WebSockets: el flujo es unidireccional, del server al cliente.
- **Calidad de código:** Vitest para tests, ESLint + Prettier.
- **Logs:** pino a archivo, con rotación.

## 4. Núcleo: sistema de jobs

Todo trabajo pesado (descarga, conversión, procesamiento de grabación) es un **job asincrónico**.

- Crear un job devuelve `202 Accepted` y un `jobId`. **Nunca** un request HTTP que espera a que termine el trabajo: se corta por timeout del navegador o del proxy, y bloquea recursos.
- **Cola:**
  - Persistida en SQLite.
  - Concurrencia máxima configurable (`MAX_CONCURRENT_JOBS`, default 2).
  - Si el server se reinicia, los jobs que estaban `running` pasan a `failed` con el motivo "interrumpido por reinicio", y los `queued` se retoman.
- **Estados:** `queued → running → done | failed | cancelled`. Un job `done` pasa a `expired` cuando la retención borra su archivo.
- **Progreso:** `GET /api/jobs/:id/events` (SSE) informa porcentaje, velocidad, ETA y fase (descargando / fusionando / convirtiendo / procesando).
  - yt-dlp: usar `--newline` y `--progress-template` con un formato parseable.
  - ffmpeg: usar `-progress pipe:1` y calcular el porcentaje contra la duración obtenida con ffprobe.
- **Cancelación:** matar el árbol de procesos completo.
  - En Windows, `process.kill()` no mata los procesos hijos (yt-dlp lanza ffmpeg). Usar `taskkill /PID <pid> /T /F` o equivalente.
  - Borrar los archivos parciales.
- Antes de iniciar un job, verificar el espacio libre en disco (`MIN_FREE_DISK_GB`). Si no alcanza, rechazarlo con un mensaje claro.

## 5. Función 1: descarga por URL

**Flujo:**

1. El usuario pega una URL. `POST /api/media/probe` ejecuta `yt-dlp -J --no-playlist`.
2. El server devuelve título, miniatura, duración, sitio de origen y las resoluciones disponibles, indicando el codec de video de cada una.
3. El usuario elige resolución y formato de salida: MP4 (default), o solo audio en MP3 o M4A.
4. `POST /api/jobs/download` crea el job.

**MP4 compatible:**

- MP4 es un contenedor, no garantiza compatibilidad. El objetivo por defecto es **H.264 + AAC**, que abre en cualquier reproductor y editor.
  - Usar el ordenamiento de formatos de yt-dlp (`-S`) priorizando h264 y m4a.
  - Usar `--merge-output-format mp4`.
- Muchos sitios (YouTube en especial) ofrecen las resoluciones altas solo en VP9 o AV1. La UI tiene que mostrarlo y ofrecer tres modos:
  - **Compatibilidad máxima** (default): la mejor resolución disponible en H.264 que no supere la elegida.
  - **Máxima calidad**: codec original (VP9/AV1) dentro de MP4. Es rápido, pero menos compatible con editores y reproductores viejos.
  - **Recodificar a H.264**: la resolución elegida en H.264. Es lento y usa mucha CPU; avisarlo.

**Reglas:**

- Validar que la URL sea `http` o `https`.
- Pasar siempre `--` antes de la URL, para que una URL que empiece con `-` no se interprete como opción.
- Traducir los errores de yt-dlp a mensajes entendibles: video privado, eliminado, con restricción geográfica o de edad, que requiere login, sitio no soportado, o "yt-dlp desactualizado: hay que actualizarlo".

## 6. Función 2: grabación de pantalla

**Dónde se graba:**

- La grabación ocurre **en el navegador del usuario**, no en el servidor. El servidor no tiene acceso a la pantalla de quien usa la web.
- APIs: `navigator.mediaDevices.getDisplayMedia` + `MediaRecorder`.

**Opciones de grabación:**

- Pantalla, ventana o pestaña (lo elige el diálogo del navegador).
- Audio del sistema o de la pestaña cuando el navegador lo permita.
- Micrófono opcional (`getUserMedia`), mezclado con Web Audio API.
- FPS: 30 o 60.

**Formato de captura:**

- Detectar el formato con `MediaRecorder.isTypeSupported`, en este orden de preferencia:
  1. `video/mp4;codecs=avc1,mp4a.40.2`
  2. `video/webm;codecs=vp9,opus`
  3. `video/webm`
- No confiar en el formato que produce el navegador: el server siempre normaliza (ver "Al finalizar").

**Subida por chunks durante la grabación:**

- Usar `timeslice` de unos 2 segundos y enviar cada chunk a `POST /api/recordings/:id/chunks` con número de secuencia.
- El server agrega los chunks a disco en orden y tolera reintentos de un chunk ya recibido.
- Así una grabación larga no vive entera en la RAM del navegador, y si se cierra la pestaña se conserva lo grabado hasta ese momento.

**Fin de la grabación:**

- Detectar cuando el usuario deja de compartir desde la barra del navegador (evento `ended` del track) y finalizar correctamente.

**Al finalizar:**

- Se crea un job de procesamiento: ffmpeg normaliza a MP4 H.264 + AAC.
  - Si la captura ya es H.264/AAC, se remuxea.
  - Si es WebM, se recodifica.
- Los WebM de MediaRecorder no traen duración ni índice de búsqueda; este paso los corrige.

**Requisito crítico:**

- `getDisplayMedia` solo existe en **contexto seguro**. Funciona en `http://localhost`, pero desde otra PC por `http://<IP>` no existe.
- Para que los compañeros puedan grabar, el server **debe** servir HTTPS en la red interna (sección 9).
- La UI tiene que detectar `!window.isSecureContext` y explicar por qué la grabación no está disponible, en vez de fallar en silencio.

## 7. Función 3: conversión

**Entrada:**

- Un archivo subido por el usuario, o un archivo del historial.
- La subida se escribe en streaming a disco, nunca en memoria. Límite: `MAX_UPLOAD_MB`.

**Análisis previo:**

- Con `ffprobe`, detectar qué tiene el archivo: video, audio, duración, resolución, codecs.
- Mostrar solo las conversiones válidas para ese archivo. Por ejemplo, un archivo de solo audio no ofrece salidas de video.

**Presets cerrados (whitelist):**

- Definidos en `packages/shared`:
  - MP4 (H.264/AAC)
  - WebM (VP9/Opus)
  - MKV
  - MOV
  - AVI
  - GIF (FPS y ancho configurables)
  - MP3
  - M4A
  - WAV
- Opcional: escalar la resolución.

**Reglas:**

- El usuario **nunca** pasa argumentos libres a ffmpeg.
- Los argumentos se construyen en código a partir del preset, con una función pura y testeada.
- El resultado es un job que queda en el historial, vinculado al job de origen (`parent_job_id`).

## 8. Historial

**Qué se guarda de cada job (SQLite):**

- id, tipo, estado
- URL de origen, título
- formato, resolución, codecs, tamaño, duración
- ruta relativa al storage
- fechas de creación y finalización
- error, si lo hubo
- IP del solicitante, `clientId`
- `parent_job_id`

**Sin login:**

- Cada navegador recibe una cookie con un `clientId` anónimo (UUID).
- La UI ofrece las vistas "Mis trabajos" y "Todos".
- Solo se pueden borrar los trabajos propios. No es seguridad (la cookie se puede falsificar), es prevención de accidentes.
- Los borrados quedan registrados en el log con la IP.

**Acciones por entrada:**

- Reproducir en el navegador, con soporte de HTTP Range para poder adelantar.
- Descargar.
- Convertir.
- Reintentar, si falló.
- Abrir la URL original.

**Archivos:**

- Se sirven por `jobId`, **nunca** por una ruta enviada por el cliente. Esto evita path traversal.
- Nombre en disco: `<jobId>.<ext>`. Esto evita caracteres prohibidos en Windows, nombres reservados y el límite de 260 caracteres de ruta.
- El título original se guarda en la DB y se usa en `Content-Disposition` al descargar, codificado según RFC 5987 para que tildes, ñ y emojis lleguen bien.
- Si el archivo ya no existe (por retención o borrado manual), la entrada queda como `expired` sin romper la UI.

**Retención y navegación:**

- Borrado automático de archivos con más de `RETENTION_DAYS` días (default 14; 0 = nunca).
- Paginación y búsqueda por título.

## 9. Despliegue en el servidor (Windows 10, red interna)

**Configuración:**

- Toda la configuración va en un `.env`, validado con Zod al arrancar. Si falta o es inválido, el server no inicia.
- Variables: `HOST`, `PORT`, `STORAGE_DIR`, `DATA_DIR`, `LOG_DIR`, `MAX_CONCURRENT_JOBS`, `MAX_UPLOAD_MB`, `RETENTION_DAYS`, `MIN_FREE_DISK_GB`, `HTTPS_CERT_PATH`, `HTTPS_KEY_PATH`, `YTDLP_PATH`, `FFMPEG_PATH`, `FFPROBE_PATH`.
- Incluir un `.env.example` comentado.
- Nada de rutas fijas en el código.
- **Storage:** en desarrollo, `./storage` (en `.gitignore`). En el servidor, una carpeta fuera del código, configurable.

**HTTPS:**

- Certificado para el hostname y la IP del servidor, generado con mkcert o con una CA interna.
- Documentar cómo instalar la CA raíz en las PCs cliente.
- HTTP sin cifrar solo se permite en localhost para desarrollo.

**Servicio y red:**

- Instalar la app como **servicio de Windows** que arranque con el equipo y se reinicie si se cae (NSSM, node-windows u otra opción; justificá la elección).
- Agregar una regla de entrada en el Firewall de Windows para el puerto.
- Documentar que el equipo no debe suspenderse.

**Scripts:**

- `scripts/setup.ps1`:
  - verifica que Node esté instalado;
  - descarga o instala `yt-dlp.exe`, `ffmpeg`/`ffprobe` y Deno (`winget install --id=DenoLand.Deno`);
  - crea las carpetas necesarias;
  - copia `.env.example` a `.env` si no existe.
- `scripts/update-ytdlp.ps1`: yt-dlp se rompe cada vez que YouTube cambia, así que actualizarlo es mantenimiento rutinario.

**Monitoreo:**

- `GET /api/health` devuelve las versiones de yt-dlp, ffmpeg y Deno, el espacio libre en disco y los jobs activos.
- La UI tiene una página "Estado" que muestra esa información.

**Documentación:**

- `docs/DEPLOY.md`: instalación paso a paso, escrita para que otra persona del área pueda instalar el sistema sin preguntarme.
- Aclarar que Windows 10 está fuera de soporte desde octubre de 2025, por lo que el servicio es **solo para la red interna** y nunca debe exponerse a internet.

## 10. Seguridad mínima (sin login, red interna)

- Procesos hijos siempre con `spawn` y un array de argumentos. Nunca `shell: true` ni concatenar strings.
- `--` antes de las URLs que se pasan a yt-dlp.
- Validación con Zod de todo input (body, params, query).
- Límites de concurrencia, de tamaño de subida y de espacio en disco.
- Nunca usar rutas de archivo que provengan del cliente.
- Opción configurable para bloquear URLs que apunten a IPs privadas o a localhost, para que la app no se use para acceder a recursos internos de la red (SSRF).
- Footer en la UI: "Usar solo con contenido propio o con autorización".

## 11. Estructura esperada

```
STI-Catcher/
├─ apps/
│  ├─ server/src/
│  │  ├─ config/         # carga y validación del .env
│  │  ├─ db/             # conexión, migraciones, repositorios
│  │  ├─ jobs/           # cola, estados, SSE, cancelación
│  │  ├─ modules/
│  │  │  ├─ download/
│  │  │  ├─ recording/
│  │  │  ├─ conversion/
│  │  │  └─ history/
│  │  ├─ adapters/       # yt-dlp, ffmpeg/ffprobe, filesystem
│  │  └─ routes/
│  └─ web/src/
│     ├─ features/{download,recording,conversion,history,status}/
│     ├─ components/
│     └─ api/            # cliente HTTP + SSE tipado con packages/shared
├─ packages/shared/src/{schemas,presets,types}/
├─ scripts/
├─ docs/{DEPLOY.md,DECISIONS.md}
├─ bin/                  # binarios (en .gitignore)
├─ storage/              # archivos generados (en .gitignore)
├─ CLAUDE.md
├─ SPEC.md
├─ README.md
└─ .env.example
```

**Capas del server:** `routes` (HTTP) → `modules` (lógica de negocio) → `adapters` (yt-dlp, ffmpeg, DB, disco).

- La lógica de negocio no conoce Fastify.
- Los adapters se mockean en los tests.
- Los tests no acceden a la red: usar fixtures con salidas reales de `yt-dlp -J` y de `ffprobe`.

## 12. Fases y criterios de aceptación

**Fase 0 — Plan.**
- Verificá el entorno: `node -v`, `git --version`, `winget --version`.
- Leé esta spec completa y señalá contradicciones, riesgos o mejoras.
- Proponé el plan y el árbol de carpetas final.
- **Sin código hasta mi OK.**

**Fase 1 — Esqueleto.**
- Monorepo, TypeScript strict, ESLint/Prettier, Vitest.
- Configuración con Zod, logs, `/api/health`, `scripts/setup.ps1`.
- `git init` + `.gitignore`, `CLAUDE.md`, `docs/DECISIONS.md`.
- ✅ Criterio: `npm run dev` levanta server y web, y la página Estado muestra las versiones de yt-dlp, ffmpeg y Deno.

**Fase 2 — Jobs + DB + SSE.**
- Cola, estados, cancelación matando el árbol de procesos, recuperación tras reinicio.
- ✅ Criterio: un job de prueba (ffmpeg generando un video de test de 60 s) muestra progreso en vivo y se puede cancelar sin dejar procesos ni archivos colgados.

**Fase 3 — Descarga por URL.**
- ✅ Criterio:
  - probe → elegir resolución → el MP4 abre en el reproductor de Windows;
  - el aviso de codec aparece cuando corresponde;
  - una URL inválida o un video privado muestran un error entendible.

**Fase 4 — Historial.**
- ✅ Criterio:
  - el historial se lista, se filtra (mis trabajos / todos) y se busca por título;
  - los videos se reproducen y se pueden adelantar;
  - se descargan con el nombre correcto, con tildes;
  - un archivo borrado aparece como expirado.

**Fase 5 — Conversión.**
- ✅ Criterio:
  - subir un `.mov` permite obtener MP4, MP3 y GIF;
  - un archivo de solo audio no ofrece salidas de video;
  - el resultado queda vinculado al original en el historial.

**Fase 6 — Grabación de pantalla.**
- ✅ Criterio:
  - una grabación de 2 minutos con audio desde localhost, cortada desde la barra del navegador, produce un MP4 con duración correcta que se puede adelantar;
  - sin contexto seguro, la UI explica por qué no se puede grabar.

**Fase 7 — Despliegue.**
- HTTPS, servicio de Windows, regla de firewall, retención automática, `docs/DEPLOY.md`.
- ✅ Criterio: desde otra PC de la red se puede descargar, convertir y grabar.

**En cada fase:**
- Tests de la lógica pura: constructores de argumentos de yt-dlp y ffmpeg, parsers de progreso, normalización de nombres, validaciones.
- Commit.
- Resumen: qué hiciste, cómo lo pruebo, qué decidiste y por qué.
- Esperá mi OK.
