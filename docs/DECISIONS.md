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

### D-041 — Cookie `clientId` con `httpOnly` · Fase 4 · Reemplazada por D-100

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

### D-062 — Borrar: solo lo propio, registro y archivo · Fase 4 · Vigente (con D-100: propio = de la misma cuenta)

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
- **Contadores en la barra lateral:** quedan para las etapas 3 y 5 (necesitan saber qué trabajos son de este navegador y siguen en curso). El punto de "grabando" no se agrega: la grabación se corta al salir de la página, así que solo se vería estando en Grabar, donde ya está el indicador.
- `docs/design/` está excluida de ESLint y Prettier (el `support.js` del mockup no es código de la app).

### D-091 — Grabar: elegir la fuente antes de grabar · Etapa 2 · Vigente

Una página no puede listar ventanas ni pantallas: elegir siempre lo hace el selector del navegador. El cambio es el orden:

1. Se elige el tipo (pantalla, ventana o pestaña).
2. `getDisplayMedia` se abre con `displaySurface` de ese tipo (Chrome y Edge abren esa solapa; Firefox lo ignora), sin ofrecer la propia pestaña de STI-Catcher (`selfBrowserSurface: exclude`).
3. Se ve en vivo lo compartido, con nombre, tamaño y si trae sonido. «Cambiar» vuelve a abrir el selector; si se cancela, queda lo anterior.
4. Recién entonces se graba, sobre el mismo stream.

Detalles:

- **Se muestra lo elegido de verdad** (`track.getSettings().displaySurface`), no lo pedido, y se marca ese tipo.
- **El nombre de la ventana:** Chrome a veces da un identificador interno (`screen:0:0`, `window:1234:0`). En ese caso se muestra solo el tipo (`friendlyTrackLabel`).
- **El aviso de «no se compartió el sonido» aparece en la vista previa**, antes de grabar, con la sugerencia de usar «Cambiar».
- **El micrófono se pide al tildarlo** (`useMicrophone`). El medidor muestra el nivel real antes de grabar y al empezar no aparece otro permiso. Se libera al destildarlo, al terminar la grabación o al salir de la página.
- **Cambiar los cuadros por segundo** con la vista previa abierta se aplica con `applyConstraints`, sin volver a elegir.
- **Si se deja de compartir desde la barra del navegador** durante la vista previa, se vuelve al inicio; durante la grabación, se detiene como antes.

Verificado con una fuente simulada (canvas 1600x900 + tono de 440 Hz como sonido del sistema, oscilador de 220 Hz como micrófono): MP4 1600x900 de 6,5 s con los dos tonos mezclados en una pista AAC estéreo.

### D-092 — Convertir varios archivos · Etapa 3 · Vigente

Sin cambios en el server: cada archivo usa los mismos endpoints de la fase 5 (`/api/uploads`, `/api/conversion/sources/:id`, `/api/jobs/convert`).

- **Lista + detalle (2e).** Cada archivo tiene su propio formato (preset, resolución, GIF). Los formatos que no tienen sentido para ese archivo no se ofrecen, igual que antes.
- **«Usar este formato en todos»** copia el formato a los demás solo donde vale. Un audio no recibe un video, y no se sube la resolución de un archivo más chico. Los que no pueden quedan como estaban.
- **Subidas de a una**, en orden. Así cada subida usa todo el ancho de banda, se respeta `MAX_UPLOAD_MB` por archivo, y quitar un archivo de la lista corta solo su subida. Los que superan el máximo no se agregan; un aviso dice cuáles.
- **«Convertir N»** crea un trabajo por archivo listo; la cola del server decide cuántos corren a la vez. El progreso llega por un solo stream SSE (`/api/events?jobIds=`).
- **La lista se guarda en `sessionStorage`** (sin los `File`). Al recargar, lo subido se vuelve a analizar y lo que se estaba subiendo se pierde (el navegador avisa antes de salir mientras sube).
- **Desde el historial o Grabar:** `?origen=id1,id2`. Los que ya están en la lista no se repiten, y después se limpia la URL.
- **Al arrastrar se muestra solo la cantidad de archivos**, no los nombres ni el tamaño: el navegador no los da hasta soltarlos (2f).
- Ids locales con un contador y no con `crypto.randomUUID`, que solo existe en contexto seguro (Convertir también se usa por `http://` en desarrollo).

Verificado con archivos reales: dos soltados en la página y tres desde `?origen=` (MOV H.264, M4A, WebM de MediaRecorder, MOV HEVC). Probé WebM 360p aplicado a todos (el audio quedó en MP3 y el WebM de 240p sin cambio de resolución), las conversiones con progreso en vivo, un GIF, la recarga y la vista de celular.

### D-093 — Descargar y convertir en un paso · Etapa 4 · Vigente

Descargar solo baja MP4, MP3 o M4A. Para ofrecer WebM, MOV, MKV, AVI, WAV o GIF (etapa 5), la descarga puede pedir una conversión que se encadena: `POST /api/jobs/download { …, then: { preset, maxHeight?, gif? } }`.

- **Qué se baja:** lo que mejor sirve de origen. M4A para presets de audio (no se pasa por MP3 antes de un WAV), MP4 en modo compatible para video y GIF. Con `then`, `format` y `videoMode` se ignoran; `maxHeight` se respeta.
- **Cuándo se crea la conversión:** cuando la descarga termina bien. La cola llama a `onDone` antes de publicar el estado final; la conversión se crea por el mismo camino que `POST /api/jobs/convert` (mismas validaciones contra el archivo real). Así el evento `done` de la descarga ya trae `followUpJobId`, y la UI sigue el segundo trabajo sin pedir nada más.
- **Vínculo propio** (`jobs.follow_up_job_id`, migración 4). `parent_job_id` no alcanza: un archivo puede tener varias conversiones hechas a mano desde el historial.
- **Si las opciones no sirven para lo que se bajó** (p. ej. el GIF termina después del final del video, que recién se conoce al bajarlo), queda una conversión **fallida con el motivo** (`queue.recordFailed`), vinculada igual. El usuario lo ve en la misma fila en vez de que no pase nada.
- **Si la descarga falla o se cancela,** no se crea la conversión. Cancelar una conversión en curso es la misma acción de siempre, sobre `followUpJobId`.
- **Reintentar** una descarga fallida vuelve a encadenar: `then` se guarda en los parámetros del job.
- **Riesgo aceptado:** si el server se corta justo entre que la descarga queda `done` y se crea la conversión (milisegundos), la descarga queda sin conversión; se puede convertir desde el historial.
- La conversión queda del mismo navegador que la descarga (`client_id`), así aparece en "Mis trabajos".

Verificado con el server real: «Me at the zoo» (YouTube, 19 s) encadenado a un GIF de 4 s a 320 px y a un MP3. Las dos descargas terminaron con `followUpJobId` y las conversiones salieron bien (el MP3 a partir de un M4A). La migración 4 se aplicó sobre una base con datos.

### D-094 — La grabación sigue al cambiar de sección · Vigente

Antes la grabación vivía en la página Grabar: ir a Descargar, Convertir, Historial o Estado la cortaba (lo grabado se procesaba igual). Ahora vive en `RecorderProvider`, montado en el layout por encima de las rutas, y la página solo muestra su estado (`useRecorder`).

- **Sigue al navegar dentro de la app**: MediaRecorder, la subida de fragmentos, el micrófono y el seguimiento del procesamiento. Al volver a Grabar se ve la vista previa, el reloj y el botón Detener.
- **Indicador en la barra lateral** junto a «Grabar pantalla»: punto rojo y tiempo mientras se graba; «subiendo…» mientras se mandan los últimos fragmentos. Reemplaza lo que D-090 había dejado sin hacer.
- **Una vista previa sin grabar no queda compartida en segundo plano**: al salir de Grabar se deja de compartir y se suelta el micrófono (la página avisa con `attachPage`). Si se sale con el selector del navegador abierto, lo que se elija se descarta.
- Recargar o cerrar la pestaña sí corta la grabación (el navegador avisa antes); lo que llegó se procesa igual.

Verificado con una fuente simulada: grabación de 25 s pasando por las cuatro secciones; el MP4 salió de 25 s. La vista previa sin grabar se cortó al ir a Descargar.

### D-095 — Descargar varios links · Etapa 5 · Vigente

Descargar pasa a ser una lista (mockup 2a): se pegan uno o varios links y cada fila tiene su formato y su calidad. Sin cambios en el server: usa `POST /api/media/probe` por link y `POST /api/jobs/download` (con `then` cuando hace falta convertir, D-093).

- **Pegar:** uno o varios links por renglón. Se validan con el mismo `httpUrlSchema` del server. Los renglones con algo que no es un link no se agregan y se listan (`renglón 3 · «…»`, 2c); quedan en el cuadro para corregirlos. Los repetidos (en lo pegado o ya en la lista) no se repiten. Ctrl+Enter analiza.
- **Análisis de a tres** (el server acepta cuatro y otra pestaña puede estar usando uno). Si el server responde 429, la fila sigue en «Analizando…» y se reintenta a los 2,5 s.
- **Formato por fila** con todos los presets de Convertir. MP4, MP3 y M4A se bajan directo; WebM, MOV, MKV, AVI y WAV se bajan y se convierten; el GIF se baja como mucho a 720p y se convierte con sus opciones (ancho y FPS en la fila; inicio y fin abajo). Lo que no tiene sentido para el video (un GIF de un audio) aparece deshabilitado.
- **Calidad:** para MP4, resolución y modo (compatibilidad / calidad / recodificar) con los avisos de codec de siempre, ahora debajo de la fila. Para el resto de los videos, la resolución que se baja.
- **«Descargar N listos»:** los tildados que están listos; si no hay ninguno tildado, todos los listos. «Formato para los seleccionados» cambia el formato de los tildados donde sirve.
- **Estado de la fila:** sigue la descarga y después la conversión encadenada («Descargado · Convirtiendo a GIF»). Cancelar corta lo que esté en curso. El botón de descarga baja el archivo final (el de la conversión, si hubo).
- **Reintentar:** un análisis fallido se vuelve a hacer; una conversión fallida se reintenta sin volver a bajar el video; una descarga fallida crea una nueva, que vuelve a encadenar la conversión.
- **La lista se guarda en `sessionStorage`** (`sti.download.batch`). Al recargar, las descargas se retoman por SSE: el server manda el estado actual de cada una y de su conversión.
- Una transmisión en vivo queda como «En vivo» y no se puede empezar; «Reintentar» la vuelve a analizar (por si ya terminó).
- **Contadores de la barra lateral:** se hicieron aparte (D-096).

Verificado con links reales: 3 de YouTube analizados en paralelo, 2 renglones inválidos y 1 repetido avisados; «Me at the zoo» bajado como MP4 (240p), GIF (2–6 s, 320 px) y WAV; las tres terminaron y cada botón bajó el archivo correcto (video/mp4, image/gif, audio/wav). La lista sobrevivió a una recarga, y un video inexistente quedó como «Falló · El video no existe o fue eliminado».

### D-096 — Contadores de trabajos en la barra lateral · Vigente (con D-100: cuenta trabajos de la cuenta)

Cierra lo que había quedado pendiente del handoff (D-090, D-095). Junto a Descargar y Convertir se ve cuántos trabajos **de este navegador** están en cola o en curso; junto a Grabar pantalla, las grabaciones que se están procesando (mientras se graba sigue el punto rojo con el tiempo, D-094).

- **Los cuenta el server** (`GET /api/active-jobs`): sabe de quién es cada trabajo por la cookie anónima de "Mis trabajos" (D-041), que JavaScript no puede leer. Responde solo números, nunca ids ni datos de otros.
- **La conversión encadenada a una descarga cuenta como descarga:** en Descargar sigue siendo la misma fila.
- **Se actualiza con eventos:** la barra lateral escucha `/api/events` (todos los trabajos) y vuelve a pedir los números cuando un trabajo cambia de estado o se borra, esperando 400 ms para juntar varios cambios en un pedido. El progreso no dispara pedidos.
- En cero no se muestra nada.

Verificado: tres conversiones lanzadas desde el navegador; el contador de Convertir pasó de 3 a 1 y desapareció al terminar, sin recargar.

### D-097 — Grabación programada: inicio y corte automáticos · Vigente

Para dejar grabando sin estar en la PC: empezar a una hora y cortar después de N minutos o a una hora.

- **El inicio programado necesita elegir la pantalla antes.** El navegador solo abre el selector con un clic de la persona; ninguna página puede abrirlo sola a una hora. Se elige la fuente, queda la vista previa y «Programar grabación» espera la hora (fase `scheduled`). La página avisa que hay que dejar la pestaña abierta y la PC sin suspender; se puede ir a otras secciones (la grabación vive en el layout, D-094) y la barra lateral muestra la hora.
- **Corte:** «Al detener» (como antes), «Por minutos» (1 a 1440) o «A una hora». Una hora que ya pasó es la del día siguiente (de 23:00 a 01:00 funciona); el máximo es un día. El resumen dice exactamente qué va a pasar («Empieza hoy a las 14:00 y termina hoy a las 15:30 (1 h 30 min)»).
- **Reloj en un Web Worker** (`background-clock.ts`): con la pestaña en segundo plano, Chrome frena los `setInterval` de la página hasta uno por minuto; los de un Worker no. Si no se puede crear, se usa `setInterval`.
- **Wake Lock** mientras se espera o se graba: pide que la pantalla no se apague (solo mientras la pestaña se ve; se vuelve a pedir al volver). No evita que Windows suspenda la PC: eso lo dice la página.
- Al empezar o cortar solo, queda un aviso («La grabación programada empezó sola», «Se detuvo automáticamente a las 15:49»). Si se deja de compartir la pantalla mientras espera, se cancela con un mensaje.
- La programación es de esta pestaña: cerrarla o recargarla la pierde (el navegador avisa). No hay programación en el server porque la captura solo existe en el navegador.

Verificado con una fuente simulada: programada para el minuto siguiente con corte a 1 minuto, esperando en Descargar; empezó a las 15:48:00, cortó sola y el MP4 duró 1:00.

### D-098 — Filtros del historial: fecha, origen y usuario · Vigente (con D-100: el usuario es la cuenta)

- **Fecha:** «Desde» y «Hasta» (días completos, en la hora de quien mira). El navegador manda el rango ya pasado a ISO (`from` inclusive, `to` exclusive) y el server compara contra `created_at`.
- **Origen = tipo de trabajo:** descargas, archivos subidos, conversiones o grabaciones (`type=a,b`).
- **Usuario = la PC que lo pidió.** No hay login, así que se usa el nombre de la PC; si no se encuentra, la IP. Elegir un usuario pasa a «Todos».
  - **Cómo se obtiene el nombre:** en la red del Centro no hay DNS inverso (`dns.reverse` → ENOTFOUND) y NetBIOS no responde, pero el resolvedor de Windows sí lo encuentra por LLMNR/mDNS. Node lo usa con `dns.lookupService`: 5–80 ms si la PC responde, unos 4,5 s hasta fallar si no. Por eso se resuelve **en segundo plano al crear el job** (no demora la respuesta), con 6 s de límite y caché (6 h los aciertos, 10 min las fallas). Se guarda el nombre corto en mayúsculas (`SISTEMAS2-PC.CAPITANES.local` → `SISTEMAS2-PC`) en `jobs.client_host` (migración 5).
  - **Se guarda, no se calcula al mirar:** con DHCP, una IP puede pasar a otra PC.
  - **Los trabajos anteriores a este cambio quedan con la IP** por la misma razón: hoy esa IP podría ser de otra PC.
  - **Cambio de criterio:** antes la API no mostraba la IP de nadie. Ahora el historial muestra quién pidió cada trabajo (`requester`), porque es lo que pide el filtro. El `clientId` de la cookie sigue sin salir nunca.
- `GET /api/history/requesters` da los valores del filtro: cada PC o IP con su cantidad de trabajos, la más reciente primero.
- Los filtros viven en la URL (`?desde=…&hasta=…&tipo=…&usuario=…`), igual que la búsqueda y la página.

Verificado: con la base de prueba (28 trabajos), un trabajo nuevo quedó como «SISTEMAS2-PC» y los viejos como 127.0.0.1; filtrar por grabaciones dio 4, por SISTEMAS2-PC 1 y desde el 4/11 15; un rango invertido avisa; «Limpiar filtros» vuelve a los 28.

### D-099 — Aviso por mail al terminar una grabación · Vigente

Pensado para las grabaciones programadas (D-097), que se dejan solas: al terminar bien una grabación se manda un mail a direcciones fijas.

- **Destinatarios fijos** (`MAIL_TO`, separados por comas), configurados en el server. No hay login para saber el mail de cada uno.
- **Solo grabaciones terminadas.** Las descargas y conversiones no avisan (serían muchos mails, y quien las pide está mirando la pantalla). Tampoco avisan las fallas: se decidió así para empezar.
- **SMTP con nodemailer** (10.1.7, sin dependencias, licencia MIT-0, con tipos propios). Se usó la versión publicada hace más de dos semanas, no la última. La casilla `soporte-notificaciones@capitanes.ar` está en Ferozo, con SSL en el puerto 465 (`SMTP_SECURITY=ssl`; también se admite `starttls` en el 587).
- **La contraseña solo va en el `.env` del server.** No se loguea; los errores de nodemailer se traducen a mensajes en español sin datos de la cuenta (`EAUTH` → usuario o contraseña, `ESOCKET`/`ECONNECTION` → host o puerto, `EENVELOPE` → destinatarios). Las direcciones de MAIL_TO tampoco salen por la API: solo cuántas son.
- **No demora la cola:** el envío va en segundo plano desde `onDone`. Si falla, queda en el log (la grabación igual está en el Historial).
- **Mail en texto plano:** título, duración, resolución, tamaño, PC que la pidió, inicio y fin (hora del server, 24 h). Sin link: se decidió que la grabación se busque en el Historial.
- **Página Estado:** muestra si está activo, el remitente y cuántos destinatarios hay, más un botón «Mandar mail de prueba» (`POST /api/mail/test`; 409 si falta configurar, 502 con el motivo si el servidor de correo falla).

Verificado con un SMTP falso local con SSL y una CA de prueba: el mail de prueba y el aviso de una grabación de 5 s llegaron con el remitente, el asunto y los dos destinatarios. Con una contraseña mala, nodemailer devolvió `EAUTH` sin la contraseña en el error, y la contraseña no apareció en los logs. Falta probarlo con la casilla real (lo hace quien cargue la contraseña).

### D-100 — La interfaz se ajusta al ancho del navegador · Vigente

Antes el contenido tenía un tope de 1080 px pegado a la izquierda: en un monitor de 1920 px quedaba más de un tercio vacío y la letra de 13 px se veía chica.

- **Todo el ancho:** `.content` ya no tiene ese tope. Solo en monitores muy anchos (más de 124 rem de contenido, ~2100 px) se centra, para no estirar las tablas de más. Los párrafos de encabezados y tarjetas siguen limitados a 75 caracteres por renglón.
- **Letra fluida:** los `font-size` pasaron de px a rem, y la base es `clamp(15px, 0.5vw + 8.1px, 17px)`: 15 px hasta ~1366 px de ventana (igual que antes) y 17 px desde ~1780 px. También van en rem los anchos que tienen que crecer con la letra: la barra lateral, la columna de opciones de Grabar, las columnas de Descargar y la grilla de Estado. Los espaciados quedan en px. La lista de Convertir va del 30 % del ancho, entre 330 px y 30 rem.
- **Columnas fijas en Descargar** (`table-layout: fixed`): antes cambiaban de ancho cuando una fila pasaba de «Listo» a «Descargando». La columna Video se queda con el resto, y los títulos se cortan con «…» al ancho de la columna. Las etiquetas de estado no se parten en dos renglones.
- **Arreglos de paso:** el texto oculto para lectores de pantalla de la columna Acciones (`position: absolute`) se salía del contenedor con scroll e ensanchaba la página entre 760 y 1100 px. Ahora `.table-wrap` es `position: relative`. En la vista angosta el contenido ocupa el 100 %: con `margin-inline: auto` en una columna flex, se achicaba a lo que medía la tabla.

Verificado midiendo, sin scroll horizontal en las cinco secciones a 2560, 1920, 1366, 1024, 800 y 375 px. A 1920 px la letra base es de 17 px y el contenido ocupa 1695 px (antes 1080).

### D-101 — Historial en tabla, con acciones agrupadas y en vivo · Vigente

El historial era una tarjeta por trabajo con hasta cinco botones (Reproducir, Descargar, Convertir, Abrir original, Borrar) y una línea larga de datos. Ahora es una tabla como la de Descargar.

- **Columnas:** Trabajo (ícono del tipo, título, tipo y de dónde salió: el sitio o «de «archivo»»), Fecha, Usuario (solo en «Todos», y «Vos» en los propios), Archivo (formato · resolución · duración), Tamaño, Estado (etiqueta, o barra con la fase mientras corre). Anchos fijos como en D-100; en pantallas angostas la tabla se desplaza de costado y la columna Trabajo mantiene 18 rem.
- **Sin miniaturas reales:** el server no guarda la imagen del video (la de yt-dlp solo se usa al analizar). Va un ícono por tipo, y uno de nota musical si el archivo es solo audio. Las miniaturas necesitarían generarlas con ffmpeg y guardarlas: queda para más adelante.
- **Acciones:** a la vista solo lo de todos los días: reproducir y descargar (íconos), o Cancelar / Reintentar según el estado. El resto (convertir, abrir el link original, borrar) va en un menú «…» (`RowMenu`): `position: fixed` para que no lo corte el scroll de la tabla, teclado con flechas, Escape y Tab, y se cierra al tocar afuera o hacer scroll. «Convertir» navega dentro de la app (un link común recargaría la página y cortaría una grabación en curso, D-094).
- **Reproducir** abre el reproductor en una fila debajo. Un GIF se muestra como imagen: con `<video>` no se veía (pasaba también antes).
- **Se actualiza solo; se sacó «Actualizar»:**
  - Los trabajos visibles siguen con `/api/events?jobIds=` como antes. Se vuelve a suscribir cuando cambia la lista y el server manda primero el estado actual de cada uno, así no se pierde un cambio que pasó mientras se pedía la lista (medido: con un solo stream general, un trabajo quedó en «Procesando» después de terminar).
  - En la primera página, un stream general detecta trabajos nuevos (`isNewJobEvent`: un `job.updated` de un trabajo que no está y es más reciente que todos, salvo la prueba del sistema) y vuelve a pedir la lista a los 400 ms.
- **Filtros en la misma tarjeta que la búsqueda**, en una fila, con el total a la derecha («8 trabajos»). Sin resultados se ve un estado vacío con «Limpiar la búsqueda y los filtros». La paginación solo aparece si hay más de una página.

Verificado con el server real: descargas MP4 y MP3, una descarga con GIF encadenado, tres conversiones de audio y una descarga cancelada. Todas aparecieron y terminaron sin recargar, y el menú anduvo con mouse y teclado. El GIF se vio, y en 390 px la tabla se desplaza sin ensanchar la página.

### D-102 — Logo propio, acento azul y más vida visual · Vigente

- **Logo nuevo** (`docs/design/logo/sti-catcher-logo.jpg`: timón con una flecha de descarga). En la barra lateral y la pestaña va solo el emblema, recortado en cuadrado (`emblem-512.png` → `public/logo-128.png` y `logo-64.png`), porque el texto no se lee a 34 px. Al lado va el nombre, con «STI» en el color de acento como en el logo. El `alt` del logo queda vacío porque el nombre ya está escrito. Reemplaza al escudo del Centro.
- **El acento pasa de violeta a azul**, el de la flecha (`#2563d6` en claro, `#5b91f0` en oscuro, con contraste AA sobre los fondos). El modo oscuro toma el azul marino del fondo del logo (`--bg: #0f1624`). La estructura de Nocturne (D-090) no cambia: botones de contorno, Inter 400/500, mismos radios y espacios.
- **Títulos de sección con ícono** (`PageTitle`, el mismo ícono de la barra lateral, en un cuadro con el tinte del acento). La sección activa de la barra lleva además una marca a la izquierda.
- **Profundidad y movimiento:** las tarjetas tienen una sombra suave además del borde (`--shadow-card`). Hay un brillo azul muy tenue arriba a la derecha y transiciones de 0,15 s en botones, opciones y filas. Los estados vacíos llevan el ícono en un círculo. Con `prefers-reduced-motion` no hay giros ni desplazamientos.
- **Estado como tablero:** arriba el aviso general con ícono, después Disco / Trabajos / Servidor con ícono (el de Disco se pone en rojo si falta espacio), después Herramientas, y «Probar sistema» y «Aviso por mail» lado a lado. Mientras llega la primera respuesta (las versiones tardan unos segundos) se ve un esqueleto con la forma de la página, y «Actualizar» gira mientras consulta.

Verificado en claro y oscuro a 1366 px y a 390 px (sin scroll horizontal en ninguna sección).

### D-103 — Pulido: mensajes, textos con cero y nombres por fila · Vigente

- **Errores que entiende cualquiera.** Cuando la respuesta no trae el formato `ApiError` de la app (la manda el proxy, un reinicio o un límite), el mensaje sale de `httpErrorMessage` (`api/client.ts`). Se usa en el cliente JSON, las subidas y los fragmentos de grabación:
  - 502, 503 y 504: «El servidor no responde: puede estar reiniciándose…».
  - 413: archivo demasiado grande. 429: demasiados pedidos.
  - Otros 5xx: «error inesperado; si se repite, avisale a quien administra STI-Catcher».
  - El resto: «No se pudo completar el pedido (error N)».

  Sin conexión: «No se pudo conectar con el servidor. Revisá la red o probá de nuevo en unos segundos.» Una respuesta con forma inesperada pide recargar la página. Antes ese caso preguntaba si server y web estaban actualizados, que no le sirve al usuario. Los mensajes propios del server siguen teniendo prioridad.

- **Sin «0»:** «Descargar 0 listos» pasa a «Descargar» y «Aplicar a 0» pasa a «Aplicar», los dos deshabilitados. El texto de ayuda del botón explica por qué.
- **Cada control de una fila de Descargar nombra su video** para los lectores de pantalla: «Formato de «…»», «Quitar «…» de la lista», «Progreso de «…»», etc. Usa el título, o el link mientras se analiza (`rowName`). El Historial ya lo hacía (D-101). En Convertir el panel de detalle es de un solo archivo, con su nombre como título, así que no hace falta.
- **Grabar en el celular:** no hubo que cambiar nada. Los navegadores de celular no tienen `getDisplayMedia`, y la página ya dice que no funciona en celulares. Las otras pantallas angostas (D-100, D-101) se desplazan sin romperse.

## Usuarios y login

### D-104 — Login con cuentas locales y avisos por usuario · Vigente (por etapas: hechas la 1, la 2 y la 3)

Hasta ahora no había login (SPEC §1 y §8): cada navegador tenía una cookie anónima (D-041) y el «usuario» del historial era la PC (D-098). El aviso de grabación iba a una lista fija (`MAIL_TO`, D-099). Ahora la app tiene que saber **quién** es cada uno para mandarle el aviso a esa persona y a los compañeros que elija. Esto cambia el alcance de la SPEC («Usuarios, login, roles» estaba fuera de alcance).

**Decidido con el usuario:**

- **Cuentas locales** en la base de STI-Catcher: se ingresa con **mail + contraseña**. El mail es a la vez el usuario y la dirección de los avisos. Se descartaron el enlace por mail (depende del SMTP para entrar) y Active Directory (más difícil de configurar y probar; se puede agregar después sin cambiar el resto).
- **Login obligatorio.** Sin sesión solo se ve la pantalla de ingreso; toda la API (salvo ingreso, recuperación de contraseña y `/api/health`) responde **401**.
- **Las cuentas las crea un administrador.** El rol admin **solo** sirve para administrar cuentas (crear, desactivar, poner una contraseña provisoria, dar o quitar admin). Para todo lo demás un admin es un usuario más: no borra ni cancela trabajos ajenos. El primer admin se crea en el servidor con un comando (`npm run user:create-admin`), no desde la web.
- **La sesión dura hasta cerrar el navegador** (cookie de sesión, sin `Max-Age`).
- **Olvido de contraseña:** link de un solo uso por mail, vence en 1 hora. El admin también puede poner una provisoria; con una provisoria hay que cambiarla al entrar.
- **Avisos por mail por trabajo:** al grabar, descargar o convertir hay «Avisar por mail»: a mí y a los compañeros que elija de la lista de usuarios.
  - Grabación: avisa al **terminar** y al **fallar**; «a mí» viene tildado.
  - Descarga y conversión: solo si se tilda (vienen sin tildar: suelen hacerse mirando la pantalla). Avisa al terminar o al fallar.
- **`MAIL_TO` se elimina.** El SMTP y el remitente siguen en el `.env`. El mail de prueba de Estado va a quien lo pide.
- **El historial anterior queda «sin cuenta»:** se ve en «Todos» con la PC o IP de siempre y nadie lo puede borrar desde la UI (como DT-002). Los trabajos nuevos quedan a nombre del usuario. No se «reclaman» por cookie: si dos personas compartían PC se asignarían mal.

**Detalles técnicos (propuestos):**

- **Tablas nuevas** (migraciones al final de `migrations.ts`): `users` (id, email único sin distinguir mayúsculas, nombre, rol `admin`/`user`, activo, hash, `must_change_password`, fechas), `sessions` (hash del token, usuario, creada, última actividad, IP) y `password_resets` (hash del token, usuario, vence, usado). `jobs` y `recordings` ganan `user_id`; `jobs` gana la lista de a quién avisar (`notify_user_ids`). Se guardan **ids**, no mails: si alguien cambia de mail o se desactiva, el aviso usa lo vigente al mandarlo.
- **Contraseñas con scrypt** (`node:crypto`, sin dependencias): N = 2^15, r = 8, p = 1, sal de 16 bytes, clave de 32 bytes, guardado como `scrypt$N$r$p$sal$hash` para poder subir los parámetros más adelante. Comparación con `timingSafeEqual`. Mínimo 10 caracteres. Se descartó argon2: necesita un módulo nativo y los scripts de instalación de npm están bloqueados (D-004).
- **Sesión:** token de 32 bytes al azar en la cookie `sti_session` (`HttpOnly`, `SameSite=Lax`, `Secure` con HTTPS, `Path=/`). En la base va solo su **SHA-256**: quien lea la base no puede usar las sesiones. Se cambia el token al ingresar (evita fijación de sesión). Como un navegador que «restaura pestañas» también restaura cookies de sesión, el server además la corta tras **12 h sin actividad**. La pestaña abierta la mantiene viva con un latido cada 10 min desde el reloj del Web Worker (D-097), así una grabación programada para dentro de 20 h igual puede empezar. Cerrar sesión, desactivar la cuenta o cambiar la contraseña cortan las sesiones al instante.
- **Límite de intentos:** 5 fallidos seguidos por cuenta bloquean esa cuenta 15 minutos; 20 por IP en 15 minutos bloquean la IP (**429**). El mensaje es siempre «Mail o contraseña incorrectos» (no dice si el mail existe), y con un mail inexistente igual se calcula un scrypt para que el tiempo de respuesta no lo delate. La recuperación responde siempre «Si el mail está registrado, te llegó un link» y tiene su propio límite.
- **CSRF:** `SameSite=Lax` ya impide que otro sitio mande la cookie en un POST; además los pedidos que cambian algo deben traer `Origin` igual al del server.
- **Nada sensible en logs ni en la API:** ni contraseñas, ni hashes, ni tokens, ni el link de recuperación. Pino redacta `password`, `token` y el header `cookie`. El log registra ingresos, fallas (con el mail y la IP) y cambios de cuentas.
- **El link de recuperación necesita la dirección pública de la app:** variable nueva `PUBLIC_URL` (p. ej. `https://192.168.3.115:3000`). Sin ella, o sin SMTP, la opción «¿Olvidaste tu contraseña?» no aparece y queda solo la provisoria del admin.
- **«Mis trabajos», borrar y los contadores** pasan a usar `user_id` en vez de la cookie anónima (D-041, D-062, D-096): se ven iguales desde cualquier PC. Los fragmentos de una grabación solo los puede mandar el usuario que la empezó. La cookie `sti_client` deja de usarse para trabajos nuevos (la columna `client_id` queda por el historial viejo).
- **Usuario del historial** (D-098): el nombre de la cuenta; para los trabajos viejos, la PC o IP como hasta ahora. El nombre de la PC se sigue guardando (sirve en el log y en el aviso).
- **Lista de compañeros para avisar:** `GET /api/users/directory` da id y nombre de los usuarios activos, sin mails.

**Etapas:**

1. **Cuentas y sesión (server + pantalla de ingreso).** Migraciones, scrypt, sesiones, límite de intentos, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, 401 en el resto, comando `user:create-admin`. Trabajos y grabaciones a nombre del usuario; «Mis trabajos» y borrar por usuario. Web: pantalla de ingreso y nombre + «Salir» en la barra lateral (toca `Layout`, poco).
2. **Administración y preferencias.** Página Usuarios (solo admin): crear, desactivar, contraseña provisoria, rol. Página «Mi cuenta»: nombre y cambio de contraseña; cambio obligatorio con provisoria.
3. **Recuperación por mail.** `PUBLIC_URL`, `POST /api/auth/forgot`, `POST /api/auth/reset`, pantallas.
4. **Avisos por usuario.** `notify_user_ids` al crear trabajos, aviso al terminar o fallar (grabación, descarga, conversión), selector «Avisar por mail» en Grabar, Descargar y Convertir, mail de prueba a quien lo pide, se quita `MAIL_TO`.
5. **Prueba de punta a punta y despliegue.** Con un SMTP falso local; `DEPLOY.md` (crear el primer admin, `PUBLIC_URL`, quitar `MAIL_TO`), `CLAUDE.md` y SPEC actualizados.

**Implementación (etapa 1):**

- **Toda la API pide sesión** (hook `onRequest` en `http/session.ts`), salvo `POST /api/auth/login`, `POST /api/auth/logout` y `GET /api/health`. La web (index.html y sus archivos) es pública para que cargue la pantalla de ingreso. Error: **401** `UNAUTHENTICATED`.
- **Origen:** un POST/DELETE con `Origin` de otro sitio recibe **403** `BAD_ORIGIN`. Sin `Origin` (curl, scripts) se acepta: la cookie `SameSite=Lax` ya no viaja en esos pedidos cruzados. En desarrollo se acepta además el origen de Vite (`127.0.0.1:5173`).
- **La cookie anónima `sti_client` ya no se crea.** Los trabajos y grabaciones nuevos guardan `user_id` (migración 6); `client_id` queda solo en los viejos.
- **Filtro Usuario:** el valor de una cuenta es `user:<id>` (un nombre de PC o una IP nunca empiezan así) y la etiqueta es su nombre. Los trabajos viejos siguen con la PC o la IP. El nombre de la PC se sigue guardando (va en el log y en el mail).
- **Primer admin:** `npm run user:create-admin` (con `tsx`, que `npm ci` instala). Pide mail, nombre y contraseña dos veces sin mostrarla; usa el mismo `.env` (o `STI_ENV_FILE`) y se puede correr con el servicio andando (SQLite en WAL). Al arrancar, si no hay ningún admin, el log lo avisa.
- **Web:** `AuthGate` pide `/api/auth/me` al cargar; sin sesión muestra solo el ingreso. Si la sesión se corta con la app abierta (otra pestaña cerró sesión), el ingreso aparece **encima** de la app sin desmontarla: una grabación en curso no se pierde y, al volver a ingresar con la misma cuenta, sigue. Con otra cuenta, se recarga. Latido a `/api/auth/me` cada 10 min desde el reloj del Worker. Nombre y «Salir» en la barra lateral. Los estilos del ingreso están en `features/auth/auth.css` (aparte de `styles.css`).
- **Logs:** pino redacta `password`, `token` y `cookie`. Un ingreso fallido registra mail, IP y motivo (`unknown`, `password`, `inactive`); nunca la contraseña.
- **Tests:** la app de prueba (`makeTestApp`) entra con la cuenta «ana» en cada `inject` (`cookie: ''` = sin sesión) y `loginAs(mail)` da otra. Usa un hash falso por velocidad; scrypt se prueba aparte. El límite de tiempo de los tests del server es 15 s (no 5): en la primera corrida después de cambiar archivos, el primer test de algunos archivos de rutas tardaba 5–7 s en Windows y fallaba solo por eso.

**Implementación (etapa 2):**

- **API de cuentas** (solo admins; si no, **403** `FORBIDDEN`): `GET /api/users`, `POST /api/users` (siempre con contraseña provisoria), `PATCH /api/users/:id` (nombre, rol, activa) y `POST /api/users/:id/password` (provisoria nueva). **Mi cuenta** (cualquiera): `PATCH /api/me` (nombre) y `POST /api/me/password` (pide la actual).
- **Reglas:** un admin no puede quitarse el rol ni desactivarse a sí mismo (**409** `SELF_CHANGE`), así nunca queda el sistema sin un admin activo; además se rechaza cualquier cambio que deje cero (`LAST_ADMIN`, por si en el futuro otra vía lo permite). Desactivar una cuenta o ponerle una provisoria corta sus sesiones. Cambiar la propia contraseña corta las **demás** sesiones y deja la actual; la nueva tiene que ser distinta, y 5 «contraseña actual» mal seguidas dan **429** (mismo límite que el ingreso).
- **Contraseña provisoria:** mientras la tenga, la API responde **403** `PASSWORD_CHANGE_REQUIRED` a todo salvo `/api/auth/me`, salir y `/api/me/password`. La web muestra solo «Elegí tu contraseña»; si se la pusieron con la app abierta (se le cortó la sesión y volvió a ingresar), aparece encima, sin desmontar la app.
- **Provisoria generada en el navegador:** 12 caracteres al azar (`crypto.getRandomValues`) sin letras que se confunden (l, 1, O, 0), ~69 bits. El admin la ve una vez en el aviso para pasársela a la persona; el server solo guarda el hash.
- **Web:** «Mi cuenta» (`/cuenta`) y «Usuarios» (`/usuarios`, el enlace solo lo ven los admins) se entran desde la cuenta en la barra lateral, debajo del nombre: no se tocó la lista de secciones de `Layout`. La tabla de cuentas se desplaza dentro de su tarjeta en pantallas angostas.

**Implementación (etapa 3):**

- **Rutas públicas:** `GET /api/auth/options` (`{ passwordReset }`: hay SMTP y `PUBLIC_URL`), `POST /api/auth/forgot` (**202** siempre igual, exista o no la cuenta; **409** `RESET_DISABLED` si no está configurado) y `POST /api/auth/reset` (**204**; **400** `INVALID_RESET_LINK` si el link venció, ya se usó o no existe).
- **Tabla `password_resets`** (migración 7): SHA-256 del token, cuenta, vencimiento (1 h), cuándo se usó e IP. Un link nuevo borra los anteriores sin usar; usarlo los borra todos.
- **El token va después de `#`** (`/restablecer#token=…`): el navegador no manda esa parte al server, así que no queda en el log de pedidos. La página lo lee y lo borra de la barra de direcciones (`history.replaceState`). En la base solo queda su hash.
- **Sin pistas:** el mail sale en segundo plano (la respuesta no espera al SMTP) y la respuesta es la misma con o sin cuenta. Una cuenta desactivada no recibe link. Si el envío falla, queda en el log.
- **Límite:** 3 pedidos por hora para el mismo mail (exista o no) y 10 por IP; después, **429**. En memoria, como el del ingreso.
- **Al usarlo:** contraseña nueva (sin marca de provisoria), se cortan **todas** las sesiones de la cuenta y se destraba el bloqueo por intentos fallidos. No deja la sesión abierta: se vuelve a ingresar. Se marca usado con un `UPDATE … WHERE used_at IS NULL`: si llegan dos pedidos juntos, gana uno.
- **Web:** «¿Olvidaste tu contraseña?» en el ingreso solo si `passwordReset`; si no, el texto de siempre (pedírsela a un admin). `/restablecer` se muestra con o sin sesión.
- **Verificado** con un SMTP falso local con TLS (certificado de prueba con openssl y `NODE_EXTRA_CA_CERTS`): el mail llegó con el link, se eligió la contraseña desde la web, la vieja dejó de servir, el link no sirvió dos veces y ni el token ni la contraseña aparecieron en el log. Con el certificado sin confiar, el envío falló con `ESOCKET` en el log y la pantalla respondió igual.

## Deuda técnica

### DT-001 — Archivos subidos como jobs `upload` · Fase 5

Modelar la subida como un job (D-030) mezcla un "archivo de entrada" con "trabajos procesados", y el historial va a tener que distinguirlos (filtro o agrupación bajo su conversión). Se acepta porque resuelve `parent_job_id` y la retención sin una tabla nueva. Revisar si el historial se vuelve confuso: la alternativa es una tabla `files` separada de `jobs`.

### DT-002 — Trabajos anteriores a la Fase 4 sin dueño · Fase 4

Los trabajos creados antes de que existiera la cookie tienen `client_id` vacío: aparecen solo en "Todos" y nadie los puede borrar desde la UI. En el servidor real no pasa (se instala con la Fase 4 ya hecha). En desarrollo los limpia la retención (Fase 7), o se borran a mano.
