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

Hay un único event bus de jobs. `GET /api/events` es el stream de una pestaña (todos los jobs que le interesan) y `GET /api/jobs/:id/events` es el mismo mecanismo filtrado por un job, no otra implementación. Se envía un comentario `: ping` cada 15 s para que ningún proxy corte la conexión por inactividad.

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

### D-031 — Recuperación al arrancar · Fase 2 · Vigente

Antes de aceptar requests:

1. Jobs `running` → `failed` con motivo "Interrumpido por un reinicio del servidor".
2. Jobs `queued` → se vuelven a encolar en su orden original.
3. Se vacía `STORAGE_DIR\tmp\` (archivos parciales de jobs que no terminaron).
4. Procesos huérfanos: se buscan procesos cuyo ejecutable esté dentro de `BIN_DIR` (yt-dlp, ffmpeg, ffprobe, deno) y se matan con `taskkill /T /F`. Se busca por ruta de ejecutable y no por el PID guardado porque Windows reutiliza los PID: matar "el PID del job anterior" podría cerrar un proceso ajeno.

Todo con tests, mockeando el adapter de procesos.

### D-032 — Grabaciones abandonadas · Fase 6 · Vigente

Si una grabación no recibe fragmentos durante `RECORDING_IDLE_MINUTES` (por defecto 2), el server la da por terminada y la procesa con lo recibido. Cubre el caso "se cerró la pestaña" de la SPEC §6. Endpoint de inicio: `POST /api/recordings` (crea la sesión y devuelve el id).

---

## Descarga y seguridad

### D-040 — `--use-extractors default,-generic` por defecto · Fase 3 · Vigente

El extractor `generic` acepta cualquier URL y descarga lo que encuentre en la página: es la puerta principal para usar la app contra recursos internos (SSRF). Deshabilitarlo deja solo los sitios con extractor propio (YouTube, Instagram, X, etc.). Configurable con `YTDLP_EXTRACTORS`. Sintaxis verificada en el README de yt-dlp (`--ies default,-generic`).

El bloqueo de URLs a IPs privadas/localhost queda como **segunda capa**. Es parcial: yt-dlp sigue redirecciones por su cuenta, y eso no se puede controlar desde afuera.

### D-041 — Cookie `clientId` con `httpOnly` · Fase 4 · Vigente

La UI no necesita leer la cookie: cada job llega con `isMine` calculado en el server. La vista "Todos" no muestra IPs (quedan en la DB y el log).

### D-042 — Actualización de yt-dlp por renombre · Fase 3 · Vigente

Windows no permite reemplazar ni borrar un `.exe` en ejecución, pero **sí renombrarlo**. `update-ytdlp.ps1`:

1. borra `yt-dlp.old.exe` si quedó de una corrida anterior (si sigue en uso, lo deja y avisa);
2. descarga a `yt-dlp.new.exe` y verifica el SHA-256;
3. ejecuta `yt-dlp.new.exe --version` como prueba de que funciona;
4. renombra `yt-dlp.exe` → `yt-dlp.old.exe` y `yt-dlp.new.exe` → `yt-dlp.exe`.

No se bloquea por jobs activos: los que están corriendo siguen con el ejecutable viejo (ya cargado en memoria) y los nuevos usan el nuevo.

### D-043 — GIF con recorte y topes · Fase 5 · Vigente

Un GIF de un video largo pesa cientos de MB. El preset GIF tiene inicio/fin (recorte) y topes configurables: duración máxima 30 s, más FPS y ancho máximos. Valores exactos en la Fase 5.

---

## Despliegue

### D-050 — WinSW 2.12 para el servicio · Fase 7 · Vigente

- **NSSM**: la última versión es de 2017 y algunos antivirus la marcan.
- **node-windows**: usa WinSW por debajo y agrega una capa más.
- **WinSW 2.12.0** (enero 2023, última estable de la rama 2.x; la v3 sigue en alpha): un solo `.exe` y un XML versionable en el repo, con reinicio automático (`<onfailure action="restart">`) y rotación de sus propios logs.

Se usa `WinSW.NET461.exe` (≈ 650 KB, requiere .NET Framework 4.6.1, que Windows 10 trae como 4.8). El release no publica checksums: `install-service.ps1` fijará el SHA-256 en el script.

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

### D-052 — CA de mkcert en las PCs cliente · Fase 7 · Vigente

`docs/DEPLOY.md` va a cubrir cómo instalar la CA raíz de mkcert (`rootCA.pem`) en "Entidades de certificación raíz de confianza" de cada PC cliente (manual o por GPO), y avisar que Firefox usa su propio almacén de certificados. La clave de la CA (`rootCA-key.pem`) no sale del servidor.

### D-053 — Windows 10 sin soporte · Fase 7 · Vigente

El soporte terminó en octubre de 2025 y las actualizaciones extendidas para usuarios particulares (ESU) en octubre de 2026. El servicio es **solo para la red interna** y nunca se expone a internet.

---

## Deuda técnica

### DT-001 — Archivos subidos como jobs `upload` · Fase 5

Modelar la subida como un job (D-030) mezcla un "archivo de entrada" con "trabajos procesados", y el historial va a tener que distinguirlos (filtro o agrupación bajo su conversión). Se acepta porque resuelve `parent_job_id` y la retención sin una tabla nueva. Revisar si el historial se vuelve confuso: la alternativa es una tabla `files` separada de `jobs`.
