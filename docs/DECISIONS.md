# Decisiones

Registro de decisiones no obvias: qué se decidió, por qué, y qué se descartó. Cada entrada indica la fase en que se aplica. Si una decisión cambia, se marca como **Reemplazada** y se agrega una nueva; no se borra.

Formato: **D-NNN — Título** · Fase · Estado.

---

## Entorno y herramientas

### D-001 — TypeScript fijado en 6.0.x · Fase 1 · Vigente

La última versión es TypeScript 7 (la reescritura en Go), pero `typescript-eslint` 8.x declara `typescript >=4.8.4 <6.1.0`. Sin typescript-eslint no hay lint con información de tipos, que es el que detecta promesas sin `await`, `any` implícitos, etc. Se usa `~6.0.3`. Revisar cuando typescript-eslint soporte la 7.

### D-002 — Node 24 LTS; `engines >=24.11` · Fase 1 · Vigente

Es la LTS activa (instalada: 24.19.0). `tsup` 9 y `vitest` 5 exigen `^24.11`. Se usan APIs incluidas en Node en lugar de dependencias: `util.parseEnv` (leer `.env`), `fs.statfs` (espacio en disco), import de JSON con `with { type: 'json' }`.

### D-003 — better-sqlite3 13 · Fase 1 (verificado) / Fase 2 (uso) · Vigente

Riesgo planteado en la Fase 0: en esta PC no hay Python ni MSVC, así que si el paquete tuviera que compilarse, la instalación fallaría. Verificado: la versión 13 trae los binarios precompilados para `win32-x64` (N-API) **dentro del paquete** y no ejecuta scripts de instalación. Se instaló y abrió una base en memoria sin compilador. Se descarta `node:sqlite` (todavía no estable).

### D-004 — Scripts de instalación de npm bloqueados · Fase 1 · Vigente

npm 12 bloquea por defecto los `postinstall` no aprobados. El único afectado es `esbuild` (lo usan tsx y tsup); su `postinstall` solo optimiza, y el binario de Windows llega igual como dependencia opcional. Verificado que funciona. No se aprueba ningún script.

### D-005 — Sin `fastify-type-provider-zod`; validación con `parseInput` · Fase 1 · Vigente

Su v7 declara `@fastify/swagger` y `openapi-types` como peers obligatorios. Para validar con Zod alcanza una función de 15 líneas (`apps/server/src/http/validation.ts`) que lanza `HttpError(400)` con el detalle por campo. Los tipos de los handlers salen del `z.output` del esquema.

### D-006 — `packages/shared` se consume como código TypeScript · Fase 1 · Vigente

`exports` apunta a `src/index.ts`. Vite y tsx lo compilan al vuelo; para producción `tsup` lo incluye en el bundle del server (`noExternal`). Así no hay paso de build intermedio ni archivos generados que se desincronicen. El resto de las dependencias del server quedan externas: pino carga sus transports (`pino-roll`) en un worker desde `node_modules`, y empaquetarlo los rompe.

### D-007 — Scripts PowerShell en UTF-8 con BOM · Fase 1 · Vigente

Windows PowerShell 5.1 (el que trae Windows 10) interpreta los `.ps1` sin BOM como ANSI: las tildes de los mensajes se rompen y pueden aparecer errores de sintaxis. Todos los `.ps1` se guardan con BOM y CRLF; `scripts/scripts.test.ts` lo verifica.

---

## Configuración

### D-010 — `.env` como única fuente; rutas relativas a su carpeta · Fase 1 · Vigente

- El server lee **solo** el `.env` (con `util.parseEnv`), no `process.env`. Así una variable suelta del sistema (p. ej. un `PORT` global) no cambia el comportamiento sin que se vea en el archivo.
- Excepción: `STI_ENV_FILE` indica dónde está el `.env`, para que en el servidor viva fuera del código.
- Las rutas relativas se resuelven contra la carpeta del `.env`, no contra el directorio de trabajo: el servicio funciona igual sin importar desde dónde lo lance WinSW.
- `parseConfig` es una función pura (recibe las variables y la carpeta base) y está testeada.
- **La misma regla vale para `vite.config.ts`** (Fase 3). Antes usaba `loadEnv` de Vite, que también toma las variables del sistema. La herramienta de preview define `PORT=5173` para el propio Vite, y el proxy de `/api` terminó apuntando a sí mismo: todas las llamadas daban 502 (medido). Ahora lee el `.env` con `util.parseEnv`, igual que el server.

### D-011 — Sin HTTPS solo se escucha en localhost · Fase 1 · Vigente

La validación del `.env` rechaza un `HOST` que no sea `127.0.0.1`/`localhost`/`::1` si no hay certificado (SPEC §9: "HTTP sin cifrar solo en localhost"). Certificado y clave van juntos.

### D-012 — Binarios en `BIN_DIR`, no instalados con winget · Fase 1 · Vigente

`winget` instala Deno y ffmpeg **por usuario** y los agrega al PATH de ese usuario. El servicio corre con otra cuenta (D-030) y no los vería: yt-dlp no encontraría Deno y fallaría con YouTube sin un error claro.

- `setup.ps1` descarga los ejecutables oficiales a `BIN_DIR` y verifica el SHA-256 publicado por cada proyecto (yt-dlp y Deno desde GitHub Releases, ffmpeg desde gyan.dev, build "essentials").
- `YTDLP_PATH`, `FFMPEG_PATH` y `FFPROBE_PATH` son overrides opcionales; vacíos = `<BIN_DIR>\<nombre>.exe`.
- **Deno no tiene variable propia**: siempre `<BIN_DIR>\deno.exe`. Se le pasa a yt-dlp con `--js-runtimes deno:<ruta>` (Fase 3; flag verificado en el README de yt-dlp).
- Fase 3: como la cuenta del servicio no tiene un perfil de usuario normal, yt-dlp usará `--cache-dir <DATA_DIR>\cache\yt-dlp` y Deno `DENO_DIR=<DATA_DIR>\cache\deno` (variable de entorno del proceso hijo). Si no, intentarían escribir en el perfil de la cuenta del servicio.

### D-013 — `setup.ps1` exige Node instalado para todos los usuarios · Fase 1 · Vigente

Mismo motivo que D-012: el servicio no ve un Node instalado en `AppData`. El script verifica que `node.exe` esté bajo `Program Files`; si no, falla con el comando para instalarlo (`winget install --id OpenJS.NodeJS.LTS --scope machine`).

- En esta PC de desarrollo Node está instalado por usuario (`AppData\Local\Microsoft\WinGet\...`), así que existe `-AllowUserNode`, que lo acepta con una advertencia.
- `install-service.ps1` (Fase 7) usará la ruta absoluta de `node.exe`, nunca `node` del PATH.

---

## Servidor HTTP

### D-020 — HTTPS ⇒ HTTP/2 con `allowHTTP1` · Fase 1 · Vigente

El navegador limita a 6 las conexiones HTTP/1.1 simultáneas **por servidor, sumando todas las pestañas**. Cada stream SSE ocupa una. Con HTTP/2 todo va multiplexado en una sola conexión. Con certificado configurado: `Fastify({ http2: true, https: { allowHTTP1: true, ... } })`.

- En desarrollo (HTTP en localhost) sigue HTTP/1.1: los navegadores no hacen HTTP/2 sin TLS. Por eso igual se mantiene D-021.
- La instancia de Fastify se castea al tipo por defecto (`as unknown as FastifyInstance`): Fastify tipa la instancia según el servidor, y las rutas se escriben contra el tipo por defecto. La API de compatibilidad de `http2` (`Http2ServerRequest`/`Response`) cubre lo que se usa, incluido `reply.raw.write` para SSE. Es el único cast de este tipo y está en `app.ts`.

### D-021 — SSE: un event bus, dos endpoints filtro · Fase 2 · Vigente

Hay un único event bus de jobs (en memoria). `GET /api/events?jobIds=…` es el stream de una pestaña y `GET /api/jobs/:id/events` es el mismo mecanismo filtrado por un job, no otra implementación.

- Al conectar se manda primero el estado actual de los jobs pedidos (`job.updated`): el cliente no depende de haber visto eventos anteriores, y al reconectar se pone al día solo.
- `/api/jobs/:id/events` se cierra cuando el job termina. El cliente también cierra su `EventSource` al ver el estado final: si no, el navegador reconectaría solo.
- Snapshot y suscripción ocurren en el mismo tick (todo sincrónico): no se pierde ningún evento en el medio.
- `app.close()` cierra los streams abiertos en un hook `preClose`. Sin eso el servicio no podría detenerse, porque los streams no terminan solos.
- Latido: ver D-025.

### D-025 — Latido SSE como evento + watchdog en el cliente · Fase 2 · Vigente

**Problema medido.** Con el server detrás de un proxy (el de Vite en desarrollo), un crash del server **no** cierra la conexión del navegador: el proxy la deja abierta sin datos, `EventSource` no se entera y la UI queda trabada en "En curso". Además, si `EventSource` recibe una respuesta HTTP de error (el 502 del proxy mientras el server reinicia), se cierra para siempre y no reintenta.

**Decisión.**

- El server manda `event: ping` cada 10 s. Es un evento con nombre y no un comentario SSE (`: ping`) porque los comentarios no llegan a JavaScript.
- El cliente (`apps/web/src/api/events.ts`) tiene un watchdog: si pasan 25 s sin recibir nada, cierra y abre otra conexión.
- Si el navegador da la conexión por cerrada (`readyState === CLOSED`), el cliente reconecta a los 3 s.

Verificado en vivo: después de un crash y reinicio, la UI pasó sola a "Falló · Interrumpido por un reinicio del servidor".

### D-026 — Cancelar es `POST /api/jobs/:id/cancel` · Fase 2 · Vigente

No `DELETE /api/jobs/:id`: eso queda para borrar del historial (Fase 4). Respuestas: 200 si estaba en cola (ya quedó cancelado), 202 si estaba corriendo (se está deteniendo; el estado final llega por SSE cuando el proceso ya terminó y los temporales están borrados), 409 si ya había terminado, 404 si no existe.

### D-027 — Sin espacio en disco: 507 al crear, `failed` al arrancar · Fase 2 · Vigente

El espacio libre (`MIN_FREE_DISK_GB`) se verifica dos veces: al crear el job (responde **507 Insufficient Storage** con un mensaje claro, sin crear nada) y justo antes de arrancarlo, porque el disco se puede llenar mientras el job espera en cola (en ese caso queda `failed` con el mismo mensaje).

### D-022 — La API no expone rutas del servidor · Fase 1 · Vigente

`/api/health` informa versiones y espacio, pero no rutas de disco. Los errores 500 devuelven un mensaje genérico; el detalle va al log. Es la red interna, pero no hay motivo para mostrar la estructura de carpetas a cualquiera.

### D-023 — Versiones de herramientas cacheadas 60 s · Fase 1 · Vigente

`yt-dlp.exe` está empaquetado con PyInstaller y se descomprime en cada ejecución: `--version` tarda 1–3 s. La página Estado tiene "Actualizar", que manda `?refresh=1` y fuerza la consulta. Consultas simultáneas comparten la misma ejecución.

### D-024 — Logs: archivo siempre, consola solo en desarrollo · Fase 1 · Vigente

`pino-roll`: rota a diario o a los 20 MB y conserva 14 archivos en `LOG_DIR`. En producción no se escribe a consola porque WinSW redirige stdout a sus propios archivos y quedaría todo duplicado.

---

## Jobs

### D-030 — Tipos de job · Fase 2 · Vigente

`download | upload | conversion | recording | selftest`.

- **`upload`** (Fase 5): cada archivo subido para convertir se registra como job, ya en `done`. Así la conversión tiene un `parent_job_id` real y la retención también borra lo subido. Ver deuda DT-001.
- **`selftest`** (antes "test"): ffmpeg genera un video sintético (`-f lavfi testsrc`) sin internet ni archivos de entrada. Sirve para:
  1. el criterio de la Fase 2 (progreso en vivo y cancelación sin procesos ni archivos colgados);
  2. un botón "Probar sistema" en la página Estado, para verificar después de una instalación o actualización que ffmpeg, la cola, el SSE y la cancelación andan en ese servidor, sin depender de YouTube.

  Se renombró a `selftest` para que no se confunda con los tests automatizados. Su archivo se borra al terminar y no aparece en "Mis trabajos".

  `-re` lee las entradas a velocidad real, así que la prueba dura lo mismo que el video y se puede ver el progreso y cancelar a mano; sin `-re`, un minuto se codifica en pocos segundos. No usa `-shortest`: medido, hacía que el progreso quedara clavado ~9 s al inicio, y las dos entradas ya duran lo mismo.

### D-031 — Recuperación al arrancar · Fase 2 · Vigente

Antes de empezar a procesar la cola, en este orden:

1. **Procesos huérfanos.** Se buscan procesos cuyo ejecutable esté dentro de `BIN_DIR` (yt-dlp, ffmpeg, ffprobe, deno) y se matan con `taskkill /T /F`. Van primero porque pueden tener abiertos archivos de `tmp`. Se busca por ruta de ejecutable y no por PID guardado porque Windows reutiliza los PID: matar "el PID del job anterior" podría cerrar un proceso ajeno. La lista sale de `Get-CimInstance Win32_Process` (PowerShell), porque `wmic` ya no viene en Windows actuales. Si no se puede listar, se avisa en el log y se sigue.
2. Se vacía `STORAGE_DIR\tmp\` (parciales de jobs que no terminaron).
3. Jobs `running` → `failed` con el motivo "Interrumpido por un reinicio del servidor".
4. Jobs `queued`: quedan como están; `queue.start()` los retoma en orden de llegada.

Verificado en vivo (crash simulado matando solo el proceso del server): mató un ffmpeg huérfano lanzado desde `bin\`, borró el parcial de `tmp` y marcó el job como interrumpido.

Dato medido: cuando el server muere, ffmpeg en general muere solo, porque se rompe el pipe de stdout donde escribe el progreso. Los huérfanos reales son más probables con procesos que no escriben seguido (yt-dlp descargando), por eso el paso 1 sigue siendo necesario.

Al detener el server en forma ordenada (Ctrl+C o detener el servicio), la cola aborta los jobs en curso (matan su árbol de procesos y quedan "interrumpido") antes de cerrar HTTP y la base.

### D-033 — Una sola instancia por `DATA_DIR` · Fase 2 · Vigente

**Riesgo encontrado al implementar D-031.** Con dos instancias sobre la misma carpeta de datos (por ejemplo `npm run dev` y `npm start` a la vez), la recuperación de la segunda mataría los ffmpeg de la primera (corren desde el mismo `BIN_DIR`) y marcaría sus jobs como interrumpidos.

**Decisión.** Lock en `DATA_DIR\sti-catcher.pid` antes de tocar procesos o la base. Si el PID del archivo corresponde a un `node.exe` vivo, la nueva instancia no arranca y explica por qué. Si quedó de una ejecución que terminó mal (el proceso no existe, o el PID lo reutilizó otro programa), se toma igual. Se libera al detener el server.

### D-034 — Migraciones como módulos TS; versión en `PRAGMA user_version` · Fase 2 · Vigente

Las migraciones son strings SQL en `apps/server/src/db/migrations.ts` y no archivos `.sql`, para que entren en el bundle de producción sin copiar archivos aparte. Cada una corre en su transacción; la versión aplicada se guarda en `PRAGMA user_version` (un entero en el encabezado del archivo), sin tabla de control. Si la base es más nueva que el código (se instaló una versión anterior de la app), el server no arranca. Una migración publicada nunca se edita: se agrega otra.

SQLite en modo WAL (las lecturas del historial y del SSE no bloquean las escrituras de la cola), `busy_timeout` 5 s, `foreign_keys` activado y `synchronous=NORMAL` (con WAL, un corte del proceso no corrompe la base).

### D-035 — Progreso en memoria, máximo cada 250 ms · Fase 2 · Vigente

El progreso no se guarda en SQLite: cambia varias veces por segundo y solo sirve mientras el job corre. Vive en la cola y se publica como máximo cada 250 ms por job, garantizando que el último valor siempre se envíe. `GET /api/jobs/:id` lo incluye mientras el job está `running`.

Las transiciones de estado sí van a la base, con un `WHERE status = …` en el mismo `UPDATE`: si cancelar y arrancar compiten, gana solo uno. Con better-sqlite3 (sincrónico) y sin `await` en el medio, `cancel()` es atómico respecto de la cola.

### D-036 — La cola es dueña de la carpeta temporal · Fase 2 · Vigente

Los runners escriben en `STORAGE_DIR\tmp` solo archivos que empiezan con el id del job. Al terminar (bien o mal), la cola borra todo lo que empiece con ese id y **recién después** publica el estado final: cuando la UI muestra "Cancelado", ya no quedan parciales. Si el job produce un archivo, la cola lo mueve a `STORAGE_DIR\files\<id><ext>` (mismo volumen: renombrar es instantáneo) y guarda la ruta relativa `files/<id><ext>`. La extensión que devuelve un runner se valida (`^\.[a-z0-9]{1,5}$`).

`runStreaming` recién resuelve en el evento `close` del proceso, es decir cuando el proceso y todos los que heredaron sus pipes terminaron: después de un abort, la cola puede borrar sabiendo que nadie tiene los archivos abiertos.

### D-037 — Velocidad de ffmpeg calculada, no la que informa ffmpeg · Fase 2 · Vigente

**Problema medido.** El `speed=` de `-progress` es un promedio desde el arranque: decía 0,1x mientras el video avanzaba a tiempo real, y el tiempo restante salía en minutos cuando faltaban segundos.

**Decisión.** Velocidad instantánea entre bloques de progreso (segundos de video avanzados ÷ segundos de reloj), suavizada con un promedio móvil exponencial (peso 0,3 para la última medición). El valor de ffmpeg solo se usa en el primer bloque. Verificado: con la prueba de 10 s, el tiempo restante bajó 8 → 7 → 5 → 4 → 3 → 2 → 1 s.

### D-032 — Grabaciones abandonadas · Fase 6 · Vigente

Si una grabación no recibe fragmentos durante `RECORDING_IDLE_MINUTES` (por defecto 2), el server la da por terminada y la procesa con lo recibido. Cubre el caso "se cerró la pestaña" de la SPEC §6. Endpoint de inicio: `POST /api/recordings` (crea la sesión y devuelve el id).

**Implementación (Fase 6):** un barrido cada 30 s busca sesiones `recording` cuyo último fragmento (o su creación, si nunca llegó ninguno) es más viejo que el límite. Con datos: se encola el procesamiento igual que con "Detener". Vacía: se descarta y se borra el archivo. El barrido usa el mismo lock por sesión que los fragmentos, así que no compite con uno que está llegando. Al arrancar el server no hace falta nada especial: las sesiones viejas de antes del reinicio las toma el primer barrido.

---

## Descarga y seguridad

### D-040 — `--use-extractors default,-generic` por defecto · Fase 3 · Vigente

El extractor `generic` acepta cualquier URL y descarga lo que encuentre en la página: es la puerta principal para usar la app contra recursos internos (SSRF). Deshabilitarlo deja solo los sitios con extractor propio (YouTube, Instagram, X, etc.). Configurable con `YTDLP_EXTRACTORS`. Sintaxis verificada en el README de yt-dlp (`--ies default,-generic`).

El bloqueo de URLs a IPs privadas/localhost queda como **segunda capa**. Es parcial: yt-dlp sigue redirecciones por su cuenta, y eso no se puede controlar desde afuera.

**Implementación (Fase 3):**

- `--use-extractors=default,-generic` va como **un solo argumento** con `=`: si el valor empezara con `-`, yt-dlp lo leería como otra opción.
- Segunda capa (`BLOCK_PRIVATE_URLS`, activada por defecto): se resuelve el host y se rechaza si **alguna** de sus IPs es interna (loopback, RFC 1918, link-local, CGNAT, multicast, reservadas; IPv4 dentro de IPv6 incluida). Usa `net.BlockList` de Node, sin rangos calculados a mano. Se verifica al analizar, al crear el job y de nuevo al ejecutarlo (el DNS pudo cambiar en el medio).
- Medido con yt-dlp real: `https://example.com/video.mp4` → "No suitable extractor found" → "El sitio no está soportado".

### D-044 — Selección de formatos: `bv+ba`, H.264 primero, estéreo · Fase 3 · Vigente

Cada punto se midió con descargas reales:

- **Sin `-S` explícito, yt-dlp elige AV1 + Opus** ("Me at the zoo": `395+251`). Por eso existe el modo compatibilidad.
- **`bv` y no `bv*`**: `bv*` acepta formatos que ya traen audio. Como se prefiere AAC, el combinado `18` (240p H.264+AAC) le ganaba al video solo, incluso en "Máxima calidad". Con `bv[height<=H]+ba/b[height<=H]/bv+ba/b`, el combinado `b` queda solo como respaldo para sitios que no separan video y audio.
- **compat**: `-S vcodec:h264,res:H,channels:2,acodec:aac` → la mejor H.264 que no supere la altura.
- **quality**: `-S res:H,acodec:aac` → el orden por defecto de yt-dlp (AV1 > VP9 > H.264).
- **Estéreo (`channels:2`) en compat, MP3 y M4A**: sin esto, Big Buck Bunny en 360p bajaba AAC **5.1 de 384 kbps** (47 MB en lugar de 27,5 MB), que algunos reproductores y editores manejan mal. Además, MP3 no admite más de 2 canales. "Máxima calidad" conserva el mejor audio, 5.1 incluido.
- `--merge-output-format mp4` (video + audio separados) y `--remux-video mp4` (sitios que dan un solo `.webm`).
- Resultado verificado con ffprobe: H.264 Main yuv420p + AAC-LC estéreo, con `moov` al principio (abre en el reproductor de Windows y se puede adelantar).

### D-045 — "Recodificar a H.264" lo hace ffmpeg, no yt-dlp · Fase 3 · Vigente

yt-dlp puede recodificar (`--recode-video`), pero no informa el progreso de esa etapa, que es justamente la más lenta. El runner descarga con la selección de "Máxima calidad" y después recodifica con nuestro ffmpeg, con progreso real (`-progress`, D-037). Usa CRF 20, preset medium, yuv420p, AAC 192 kbps estéreo y `+faststart`.

### D-046 — El análisis no es un job, pero tiene límite · Fase 3 · Vigente

`POST /api/media/probe` responde en el mismo request (yt-dlp `-J` tarda 5–12 s, medido) porque el usuario lo espera para elegir opciones. Para que nadie lo sature sin login, hay como máximo 4 análisis simultáneos; el quinto recibe **429** con un mensaje para reintentar. Timeout de 90 s.

### D-047 — Progreso de yt-dlp con plantilla propia · Fase 3 · Vigente

- `--progress-template` con campos separados por `|` (`STI_PROGRESS status|bajado|total|estimado|velocidad|eta`). yt-dlp escribe `NA` cuando no tiene el dato.
- `--print before_dl:STI_INFO {título, formato, …}`: el `format_id` (`133+140`) dice cuántos streams se van a bajar.
- **Medido:** el progreso de descarga sale por stdout y el de postproceso (Merger, ExtractAudio) **por stderr**. Se leen los dos.
- Con video + audio, el video pesa el 90 % de la barra y el audio el 10 %. Repartir 50/50 hacía que la barra llegara a la mitad enseguida y se quedara quieta.
- Los postprocesos no informan porcentaje: la UI muestra la fase ("Uniendo audio y video") con una barra animada.

### D-048 — Archivo final: datos de ffprobe y descarga con RFC 5987 · Fase 3 · Vigente

- Al terminar, ffprobe sobre el archivo real: duración, resolución y codecs que se guardan en el job (no lo que dijo el sitio).
- `GET /api/jobs/:id/file`: se pide por jobId, la ruta sale de la base y se verifica que esté dentro de `STORAGE_DIR\files`. `reply.download` de `@fastify/static` arma `Content-Disposition` según RFC 5987 (verificado: "Canción del ñandú 🎵" llega intacto) y soporta Range (206). 409 si el job no terminó, **410** si el archivo ya no está.
- El nombre de descarga es el título sin caracteres prohibidos en Windows, sin nombres reservados (CON, NUL…), hasta 150 caracteres sin partir emojis, normalizado a NFC.
- Se adelantó de la Fase 4 porque el criterio de la Fase 3 pide abrir el MP4. La Fase 4 agrega el historial y el reproductor.

### D-041 — Cookie `clientId` con `httpOnly` · Fase 4 · Vigente

La UI no necesita leer la cookie: cada job llega con `isMine` calculado en el server. La vista "Todos" no muestra IPs (quedan en la DB y el log).

**Implementación (Fase 4):** cookie `sti_client` con un UUID, `HttpOnly`, `SameSite=Lax` y `Secure` solo con HTTPS (si no, el navegador no la mandaría en desarrollo). Se renueva en cada respuesta con 400 días de vida (el máximo que acepta Chrome). Sin dependencias: el header `Cookie` se parsea a mano, y un valor que no es UUID se reemplaza. La API nunca devuelve el clientId ni la IP de nadie (hay un test que lo verifica).

### D-042 — Actualización de yt-dlp por renombre · Fase 3 · Vigente

Windows no permite reemplazar ni borrar un `.exe` en ejecución, pero **sí renombrarlo**. `update-ytdlp.ps1`:

1. borra `yt-dlp.old.exe` si quedó de una corrida anterior (si sigue en uso, lo deja y avisa);
2. descarga a `yt-dlp.new.exe` y verifica el SHA-256;
3. ejecuta `yt-dlp.new.exe --version` como prueba de que funciona;
4. renombra `yt-dlp.exe` → `yt-dlp.old.exe` y `yt-dlp.new.exe` → `yt-dlp.exe`.

No se bloquea por jobs activos: los que están corriendo siguen con el ejecutable viejo (ya cargado en memoria) y los nuevos usan el nuevo.

**Implementación (Fase 3):**

- Si un `yt-dlp.old.exe` anterior sigue en uso (un job muy largo), no se puede borrar ni pisar: el actual se renombra a `yt-dlp.old.<fecha>.exe`, y la próxima corrida borra todos los `yt-dlp.old*.exe`.
- Si el segundo renombre falla, se deshace el primero: nunca queda el sistema sin `yt-dlp.exe`.
- `-Force` reinstala aunque sea la misma versión (para reparar un ejecutable dañado).
- Las funciones compartidas con `setup.ps1` (leer el `.env`, descarga con SHA-256) están en `scripts/common.ps1`.
- Verificado: la actualización completa contra GitHub (renombre + versión nueva), y en Windows 10 que un `.exe` en ejecución **no se puede borrar pero sí renombrar**, y que el proceso sigue corriendo después.
- **Medido:** en PowerShell 5.1, `& exe --version | Select-Object -First 1` corta el proceso y deja `$LASTEXITCODE` en -1. Por eso se captura toda la salida antes de mirarla.

### D-043 — GIF con recorte y topes · Fase 5 · Vigente

Un GIF de un video largo pesa cientos de MB. El preset GIF tiene inicio/fin (recorte) y topes configurables: duración máxima 30 s, más FPS y ancho máximos. Valores exactos en la Fase 5.

**Implementación (Fase 5):**

- `.env`: `GIF_MAX_SECONDS=30`, `GIF_MAX_FPS=15`, `GIF_MAX_WIDTH=800`. Por defecto se proponen 10 fps y 480 px, siempre sin pasar los topes ni el ancho del video.
- El server valida contra los topes y contra la duración real del archivo (ffprobe). La UI muestra los mismos problemas antes de enviar y deshabilita el botón.
- Paleta propia en una sola pasada (`palettegen` + `paletteuse`, dither bayer): con la paleta genérica, el GIF sale con bandas y ruido. El recorte (`-ss`/`-t`) va **antes** de `-i`, así ffmpeg salta directo al inicio. Sin audio.
- Verificado: de 2 a 7 s a 10 fps dio exactamente 5,0 s y 50 cuadros, 480×270, 1,2 MB.

---

## Historial

### D-060 — Búsqueda sin tildes: columna `title_search` · Fase 4 · Vigente

SQLite compara con `LIKE` sin distinguir mayúsculas solo en ASCII, y no sabe quitar tildes. El título normalizado (NFD, sin diacríticos, en minúsculas) se guarda en `title_search` al crear el job y al terminar (cuando yt-dlp informa el título real), y la búsqueda se normaliza igual. "cancion" encuentra "Canción"; "nandu", "Ñandú". `%` y `_` en la búsqueda se escapan (`ESCAPE '\'`): se toman literalmente.

La migración 2 completa los registros que ya existían. Para eso, las migraciones aceptan un paso opcional en JS (`migrate(db)`), en la misma transacción que el SQL.

### D-061 — "Expirado" se detecta al mirar · Fase 4 · Vigente

Al listar el historial (una página: hasta 20 `stat`) y al pedir un archivo, si un job `done` ya no tiene su archivo, pasa a `expired` y se publica por SSE. Así un borrado manual o la retención (Fase 7, que también lo marca directamente) nunca dejan un link roto. Es la única transición desde un estado final.

### D-062 — Borrar: solo lo propio, registro y archivo · Fase 4 · Vigente

- Solo el navegador que lo creó (cookie), si no **403**. No es seguridad, es prevención de accidentes (SPEC §8).
- Un trabajo en curso no se borra (**409**): primero hay que cancelarlo.
- Se borran la fila y el archivo. Se publica `job.deleted`, y las otras pestañas lo quitan de la lista sin recargar.
- Log: "Trabajo borrado del historial", con id, título, IP de quien borra e IP de quien lo creó.

### D-063 — Reintentar crea un trabajo nuevo · Fase 4 · Vigente

Un trabajo `failed` o `cancelled` se reintenta con los mismos parámetros, como trabajo **nuevo** a nombre de quien reintenta. El original queda en el historial como estaba. Por ahora solo las descargas; las conversiones se suman en la Fase 5.

### D-064 — Reproducción y lista en vivo · Fase 4 · Vigente

- `GET /api/jobs/:id/file?inline=1` → `Content-Disposition: inline` (con nombre RFC 5987) para `<video>`/`<audio>`, con Range. Verificado: adelantar al segundo 90 pide 206 y sigue reproduciendo.
- La página se suscribe a `/api/events?jobIds=<los visibles>`: progreso de los que están corriendo, terminados, expirados y borrados, sin recargar. Los eventos no traen `isMine` (depende de quién mira): la lista lo conserva.
- Filtro, búsqueda y página viven en la URL (`?scope=all&q=…&page=2`).
- El selftest no aparece en el historial (D-030).

## Conversión

### D-070 — Presets cerrados en `shared` · Fase 5 · Vigente

Los nueve presets (MP4, WebM, MKV, MOV, AVI, GIF, MP3, M4A, WAV) están en `packages/shared/src/presets/conversion.ts`: id, etiqueta, descripción, extensión, qué necesita del origen (video o audio) y si admite escalar. El cliente solo manda el **id**. Los argumentos de ffmpeg los arma `buildConversionArgs` (función pura y testeada, en `modules/conversion/conversion-args.ts`), sin texto del cliente (SPEC §7).

| Preset    | Salida                                         | Por qué                                                   |
| --------- | ---------------------------------------------- | --------------------------------------------------------- |
| MP4 / MOV | H.264 CRF 20 + AAC 192k, `+faststart`          | Abre en cualquier lado / editores                         |
| MKV       | copia (o H.264 + AAC si se escala)             | MKV acepta casi cualquier codec: sin pérdida, en segundos |
| WebM      | VP9 CRF 32 + Opus 128k, `cpu-used 4`, `row-mt` | Calidad aceptable sin tardar una eternidad                |
| AVI       | MPEG-4 Part 2 tag XVID + MP3                   | Lo que abren reproductores y equipos viejos               |
| MP3       | LAME VBR q2 (~190 kbps)                        | Indistinguible del original para voz y música             |
| M4A       | AAC 192k (o copia si ya es AAC)                |                                                           |
| WAV       | PCM 16 bits                                    | Para edición de sonido                                    |

- **Copiar sin recodificar** cuando el origen ya cumple: MP4/MOV si es H.264 8 bits (yuv420p) + AAC y no se escala; M4A si ya es AAC; MP3 si ya es MP3. Verificado: un MP4 de 10,6 MB pasó a MOV en 0,6 s.
- Más de 2 canales → estéreo en MP3, M4A, WebM y MP4 (MP3 no admite más; los demás, por compatibilidad). Mono queda mono.
- Escalar: solo hacia abajo (`scale=-2:H`, ancho par) y solo en presets de video. Una altura igual o mayor que la original se ignora.

### D-071 — Solo se ofrecen las conversiones con sentido · Fase 5 · Vigente

`GET /api/conversion/sources/:id` corre ffprobe sobre el archivo real y devuelve qué tiene (video, audio, duración, resolución, codecs) y los presets válidos (`availablePresets`, compartida con la web). Un archivo de solo audio no ofrece salidas de video ni GIF, y uno sin audio no ofrece MP3/M4A/WAV. Al crear la conversión el server lo vuelve a validar (**422** si no tiene sentido). Verificado en vivo con un .mov HEVC (9 opciones) y una nota de voz .m4a (solo MP3, M4A y WAV).

El origen puede ser un archivo subido o **cualquier** trabajo terminado del historial (botón "Convertir"), propio o ajeno: convertir no modifica el original.

### D-072 — Subida: cuerpo binario en streaming · Fase 5 · Vigente

- `POST /api/uploads` con el archivo como cuerpo (`application/octet-stream`) y el nombre en el header `x-file-name` (URL-encoded). Sin multipart ni dependencias: un content-type parser de Fastify pasa el stream sin leerlo, y se escribe directo a `STORAGE_DIR\tmp` con `pipeline`. El archivo nunca está entero en memoria (SPEC §7).
- Límite `MAX_UPLOAD_MB`: se rechaza antes de leer si `Content-Length` lo supera (**413**), y si no hay `Content-Length`, un contador corta el stream al pasarse. También se verifica el espacio en disco (**507**).
- ffprobe confirma que es video o audio; si no, se borra (**422**). El nombre del cliente solo es título: en disco queda `<jobId><ext>`, con la extensión validada (`.bin` si es rara).
- Queda en el historial como trabajo `upload` ya terminado (D-030, DT-001), con `queue.recordCompleted`.
- La web sube con `XMLHttpRequest` y no con `fetch`, porque `fetch` no informa el progreso de una subida.

### D-073 — La conversión queda vinculada al original · Fase 5 · Vigente

El job de conversión tiene `parent_job_id` = el origen y el título "Original → MP4". El historial muestra "Convertido de «…»" (`parentTitle`, resuelto en el server). Si el origen se borra o expira mientras la conversión espera en la cola, el runner falla con "El archivo de origen ya no está disponible". Las conversiones fallidas o canceladas se pueden reintentar.

## Grabación de pantalla

### D-080 — Sesión de grabación fuera de la cola · Fase 6 · Vigente

Mientras se graba no hay job: hay una **sesión** en la tabla `recordings` (estado `recording` → `finalized` o `discarded`). El job `recording` se crea recién al terminar, y es el que procesa el archivo. Así la grabación no ocupa un lugar de `MAX_CONCURRENT_JOBS` durante minutos sin hacer nada, y el historial solo muestra grabaciones que ya se pueden procesar.

El archivo crudo se escribe en `STORAGE_DIR\recordings\<recordingId>.<webm|mp4>`, **no** en `tmp`: la recuperación al arrancar vacía `tmp` (D-031), y una grabación en curso tiene que sobrevivir a un reinicio del server. El runner borra el crudo solo si el procesamiento salió bien; si falla, queda para "Reintentar".

### D-081 — Protocolo de fragmentos · Fase 6 · Vigente

`POST /api/recordings/:id/chunks?seq=N` con el fragmento como `application/octet-stream` (sin multipart, igual que D-072). El server lleva `next_seq` en la base:

- `seq == next_seq`: se agrega al archivo y se avanza, en un `UPDATE … WHERE next_seq = ?` atómico.
- `seq < next_seq`: es un reintento de algo que ya llegó (la respuesta se perdió): se descarta el cuerpo y se responde OK con `nextSeq`. Reintentar nunca duplica video.
- `seq > next_seq`: 409, falta uno anterior.
- Si el cuerpo se corta a mitad, el archivo se trunca al tamaño anterior y se responde error: el cliente reintenta el mismo número.

Un lock por sesión serializa fragmentos, "Detener" y el barrido de D-032. Tope por fragmento: 64 MB (a 8 Mbps un fragmento de 2 s pesa ~2 MB). Solo el navegador que creó la sesión (cookie de D-041) puede enviar fragmentos o terminarla.

En la web, `ChunkUploader` envía de a uno y en orden; ante errores de red o 5xx reintenta el mismo número con espera creciente (1, 2, 4… hasta 15 s, 6 intentos). Ante 403/404/409/413/507 no reintenta, corta la grabación y pide procesar lo que llegó.

### D-082 — Formato de grabación y procesamiento · Fase 6 · Vigente

El navegador elige el primer formato que soporte: `video/mp4;codecs=avc1,mp4a.40.2` (Chrome/Edge actuales), `video/webm;codecs=vp9,opus`, `video/webm`. El resultado siempre es **MP4 H.264 + AAC** con `+faststart`:

- Si ya viene en H.264 yuv420p y el audio es AAC o no hay audio: se copia sin recodificar (segundos).
- Si no: se recodifica con `libx264 -preset veryfast -crf 23`, AAC 160 kbps, `-fps_mode cfr -r <fps>` (MediaRecorder graba con cuadros a intervalos variables y algunos reproductores lo saltean mal) y escala a dimensiones pares (`yuv420p` lo exige; una ventana puede medir 1281×721).

**Medido:** el WebM de MediaRecorder no trae duración ni índice (ffprobe: `N/A`), y por eso no se puede adelantar. El progreso usa la duración estimada desde la sesión (creación → último fragmento). Verificado con una grabación simulada de 2:10 cortada desde "Dejar de compartir": MP4 de 129,9 s, `moov` antes de `mdat`, se adelanta a 1:40 en el reproductor, audio presente.

### D-083 — Audio: una sola pista · Fase 6 · Vigente

MediaRecorder graba una pista de audio. Si se pide sonido del sistema **y** micrófono, se mezclan con Web Audio (`AudioContext` → `MediaStreamDestination`). Si el usuario no tilda "Compartir audio" en el selector del navegador, se avisa en vez de grabar en silencio sin decir nada. Sin contexto seguro (`http://<IP>`) `getDisplayMedia` no existe: la página explica que hace falta HTTPS (Fase 7) en vez de mostrar un botón que falla.

### D-084 — Parser de `application/octet-stream` en `app.ts` · Fase 6 · Vigente

Lo usan la subida de la conversión y los fragmentos de grabación: se registra una vez en `app.ts` (deja el cuerpo como stream, sin leerlo) en vez de en cada archivo de rutas.

---

## Despliegue

### D-050 — WinSW 2.12 para el servicio · Fase 7 · Vigente

- **NSSM**: la última versión es de 2017 y algunos antivirus la marcan.
- **node-windows**: usa WinSW por debajo y agrega una capa más.
- **WinSW 2.12.0** (enero 2023, última estable de la rama 2.x; la v3 sigue en alpha): un solo `.exe` y un XML versionable en el repo, con reinicio automático (`<onfailure action="restart">`) y rotación de sus propios logs.

Se usa `WinSW.NET461.exe` (≈ 650 KB, requiere .NET Framework 4.6.1, que Windows 10 trae como 4.8). El release no publica checksums: `install-service.ps1` fijará el SHA-256 en el script.

**Implementación (Fase 7):**

- **SHA-256 fijado:** `B5066B7B…ADFC4F`, calculado al descargarlo de la URL oficial del release. No hay una segunda fuente para compararlo: GitHub no publica el digest de assets de 2023 y Scoop solo empaqueta las variantes `-x64`/`-x86`. El de mkcert sí coincide con el manifiesto de Scoop.
- **El XML no se versiona:** se genera en `service\sti-catcher.xml` (en `.gitignore`), porque lleva rutas de cada equipo: Node, la app, el `.env`, los logs. `install-service.ps1` lo valida con `sti-catcher.exe status`, que no requiere administrador.
- **`<stopparentprocessfirst>true`:** por defecto WinSW 2.x corta primero a los procesos hijos. ffmpeg moriría antes que Node y el job quedaría como "falló" con un error de ffmpeg, en vez de "interrumpido". Con esta opción, Node recibe Ctrl+C, aborta la cola y mata a sus hijos (D-031). `<stoptimeout>` es de 30 s.
- **Ejecutable:** la ruta absoluta de `node.exe` (para todos los usuarios), con `STI_ENV_FILE` apuntando al `.env`.
- **Inicio y fallas:** inicio automático retrasado (deja que la red esté lista) y reinicio a los 10 s, 30 s y 2 min, con el contador puesto a cero tras 1 h estable.

### D-051 — Cuenta del servicio: virtual `NT SERVICE\sti-catcher` · Fase 7 · A verificar en la instalación

El servicio **no** corre como LocalSystem (es el default de WinSW).

Qué documenta WinSW 2.12 (`doc/xmlConfigFile.md`): `<serviceaccount>` con `<domain>`, `<user>`, `<password>` y `<allowservicelogon>`. Para LocalService: `<domain>NT AUTHORITY</domain><user>LocalService</user>` sin contraseña. **No documenta cuentas virtuales.**

Qué hace el código de 2.12.0 (`src/WinSW/Program.cs`, `ServiceAccount.cs`): arma la cuenta como `dominio\usuario` y se la pasa a `CreateService` de Windows, con la contraseña en `null` si no hay `<password>`. Windows acepta así una cuenta virtual (`NT SERVICE\<nombre del servicio>`, sin contraseña). Por eso la configuración prevista es:

```xml
<id>sti-catcher</id>
<serviceaccount>
  <domain>NT SERVICE</domain>
  <user>sti-catcher</user>
</serviceaccount>
```

Por qué cuenta virtual y no LocalService: LocalService es compartida por varios servicios de Windows, así que darle permiso de escritura a una carpeta se lo da a todos ellos. La cuenta virtual es exclusiva de este servicio y no tiene contraseña que administrar.

Permisos (en `install-service.ps1`, **después** de crear el servicio, porque antes la cuenta virtual no existe):

- Lectura y ejecución: carpeta de la app, `BIN_DIR` y la carpeta de Node.
- Modificación: solo `STORAGE_DIR`, `DATA_DIR` y `LOG_DIR`.
- Lectura de la clave privada del certificado: solo esta cuenta y Administradores.

Plan B si en la instalación real `CreateService` rechaza la cuenta virtual: instalar con LocalService y cambiarla con `sc.exe config sti-catcher obj= "NT SERVICE\sti-catcher"` (soportado por Windows). Se verifica y documenta en `docs/DEPLOY.md` en la Fase 7.

**Implementación (Fase 7):**

- **Plan B automático:** el plan B quedó automatizado en `install-service.ps1`. Después de instalar, el script verifica con `Win32_Service.StartName` que la cuenta sea la virtual; si no lo es, falla.
- **Sin contraseña en `sc.exe`:** no se le pasa `password=`. PowerShell 5.1 descarta los argumentos vacíos, y una cuenta virtual no lleva contraseña.
- **ACLs con SIDs de grupos integrados** (`*S-1-5-32-544`, `*S-1-5-18`): en un Windows en español el grupo se llama "Administradores" y los nombres en inglés no existen.
- **Rutas dentro de un perfil:** el script rechaza la app o los datos dentro de `C:\Users\…`, porque la cuenta virtual no entra a perfiles ajenos.
- **Pendiente:** la instalación real (requiere administrador) no se corrió en desarrollo. Se probó `-DryRun`, que valida configuración, descarga y XML.

### D-052 — CA de mkcert en las PCs cliente · Fase 7 · Vigente

`docs/DEPLOY.md` va a cubrir cómo instalar la CA raíz de mkcert (`rootCA.pem`) en "Entidades de certificación raíz de confianza" de cada PC cliente (manual o por GPO), y avisar que Firefox usa su propio almacén de certificados. La clave de la CA (`rootCA-key.pem`) no sale del servidor.

**Implementación (Fase 7):** `scripts/new-certificate.ps1`:

- **mkcert:** descarga mkcert 1.4.4 con SHA-256 fijado.
- **CA:** `mkcert -install` instala la CA en el almacén del usuario que corre el script. La CA vive en su perfil (`mkcert -CAROOT`), no en `DATA_DIR`, para que la cuenta del servicio no pueda leer su clave.
- **Certificado del servidor:** emitido para el nombre del equipo, su FQDN, sus IPv4 (sin APIPA ni loopback), `localhost` y `127.0.0.1`. Se guarda en `DATA_DIR\certs` y se escribe en el `.env`.
- **CA pública para las PCs cliente:** se copia a `DATA_DIR\certs\sti-catcher-ca.crt`.

Si otra persona regenera el certificado desde su usuario, se crea **otra** CA y hay que redistribuirla. `DEPLOY.md` lo advierte.

### D-054 — Retención automática · Fase 7 · Vigente

`modules/retention/retention-service.ts` hace una pasada al arrancar y después cada hora (`RETENTION_DAYS=0` la desactiva):

1. Jobs `done` con archivo que terminaron hace más de N días: se borra el archivo y el job pasa a `expired` (sigue en el historial). Se excluye el origen de una conversión en cola o en curso. Si no se puede borrar (por ejemplo, alguien lo está reproduciendo), se reintenta en la próxima pasada.
2. Huérfanos de `files/`: archivos viejos que ningún job `done` usa, como un borrado que falló a mitad. Se decide por el registro en la base, no por la fecha del archivo: yt-dlp puede dejar la fecha de publicación del video.
3. Crudos de grabación viejos en `recordings/`: los que nunca se procesaron, o cuyo procesamiento falló y se guardaban para reintentar. Una grabación en curso recibe un fragmento cada 2 s, así que nunca es vieja.

### D-055 — HTTPS verificado en producción · Fase 7 · Vigente

Con un certificado de una CA de prueba y `NODE_ENV=production`, por un cliente HTTP/2 de Node, funcionaron:

- negociación `h2` y fallback HTTP/1.1;
- la SPA;
- SSE;
- subida en streaming;
- fragmentos de grabación y su procesamiento;
- Range con 206.

La capa de compatibilidad `http2` de Fastify cubre lo que usa la app.

Puerto sugerido: **443**, para que la dirección no lleve puerto. En Windows no hay puertos privilegiados para un socket común, así que la cuenta virtual puede escuchar en 443.

### D-053 — Windows 10 sin soporte · Fase 7 · Vigente

El soporte terminó en octubre de 2025 y las actualizaciones extendidas para usuarios particulares (ESU) en octubre de 2026. El servicio es **solo para la red interna** y nunca se expone a internet.

---

## Interfaz

### D-090 — Rediseño Nocturne por etapas · Etapa 1 · Vigente

Los mockups están en `docs/design/nocturne/` (README con las medidas, `tokens.css`, el HTML de referencia). Se aplican en 5 etapas, cada una con su commit: 1) tokens, barra lateral y componentes globales; 2) grabar con vista previa de la fuente; 3) convertir varios archivos; 4) conversión encadenada a la descarga (server); 5) descargar varios links.

Cambios respecto del handoff:

- **Inter incluida en la app** (`@fontsource/inter`, solo 400 y 500) en vez de Google Fonts: las PCs de la red pueden no tener internet, y cada visita avisaría a Google. El navegador baja solo el subconjunto latino (~48 KB).
- **Íconos con los nombres `*Icon`** de Phosphor 2.1 (los nombres sin sufijo están marcados como obsoletos). Vite deja en el bundle solo los usados (+11 KB).
- **`strong`, `b` y `th` en 500**: sin esto el navegador sintetiza una negrita que no existe.
- **Contadores y punto de grabación en la barra lateral:** quedan para las etapas 2, 3 y 5. Necesitan saber qué trabajos son de este navegador y siguen en curso, y hoy la grabación se corta al cambiar de página.
- `docs/design/` está excluida de ESLint y Prettier (el `support.js` del mockup no es código de la app).

## Deuda técnica

### DT-001 — Archivos subidos como jobs `upload` · Fase 5

Modelar la subida como un job (D-030) mezcla un "archivo de entrada" con "trabajos procesados", y el historial va a tener que distinguirlos (filtro o agrupación bajo su conversión). Se acepta porque resuelve `parent_job_id` y la retención sin una tabla nueva. Revisar si el historial se vuelve confuso: la alternativa es una tabla `files` separada de `jobs`.

### DT-002 — Trabajos anteriores a la Fase 4 sin dueño · Fase 4

Los trabajos creados antes de que existiera la cookie tienen `client_id` vacío: aparecen solo en "Todos" y nadie los puede borrar desde la UI. En el servidor real no pasa (se instala con la Fase 4 ya hecha). En desarrollo los limpia la retención (Fase 7), o se borran a mano.
