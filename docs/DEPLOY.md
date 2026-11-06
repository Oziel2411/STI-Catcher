# Instalación en el servidor

Guía paso a paso para instalar STI-Catcher en una PC con Windows 10 que hace de servidor en la red interna. Los compañeros entran desde el navegador, sin instalar nada más que el certificado de la red (paso 8).

> **Solo red interna.** Windows 10 no tiene soporte de Microsoft desde octubre de 2025 (las actualizaciones extendidas para particulares terminaron en octubre de 2026). Este equipo **nunca** debe quedar expuesto a internet: nada de redirigir puertos en el router ni publicarlo por VPN a terceros. La app no tiene login.

## Qué hace falta

- Windows 10 de 64 bits, con una cuenta de **administrador**.
- **IP fija** (o una reserva en el DHCP). El certificado incluye la IP: si cambia, hay que regenerarlo (ver [Mantenimiento](#mantenimiento)).
- La red del equipo como **Privada** o **Dominio**, no Pública: Configuración → Red e Internet → Propiedades de la conexión.
- Espacio en disco para los videos. Conviene un disco de datos aparte.
- Conexión a internet durante la instalación (descarga Node.js, yt-dlp, ffmpeg, Deno, mkcert y WinSW de sus sitios oficiales).

Carpetas que propone esta guía:

| Carpeta                  | Contenido                                     |
| ------------------------ | --------------------------------------------- |
| `C:\STI-Catcher\app`     | el código, `.env`, `bin\` (yt-dlp, ffmpeg…)   |
| `C:\STI-Catcher\storage` | videos y archivos (puede estar en otro disco) |
| `C:\STI-Catcher\data`    | base de datos y certificados                  |
| `C:\STI-Catcher\logs`    | logs de la app y del servicio                 |

No uses una carpeta dentro de `C:\Users\…`: el servicio corre con su propia cuenta y no tiene acceso a los perfiles de usuario. El instalador lo verifica.

Todos los comandos van en **PowerShell como administrador** (clic derecho en Inicio → «Windows PowerShell (administrador)»).

## 1. Node.js para todos los usuarios

```powershell
winget install --id OpenJS.NodeJS.LTS --scope machine
```

Cerrá y volvé a abrir PowerShell como administrador. `node -v` tiene que mostrar 24 o más. Tiene que quedar en `C:\Program Files\nodejs`: un Node instalado «solo para mí» no lo puede usar el servicio.

## 2. El código

Copiá el proyecto a `C:\STI-Catcher\app`, con `git clone` o descomprimiendo el ZIP. Después:

```powershell
cd C:\STI-Catcher\app
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\setup.ps1
```

`setup.ps1` verifica Node, crea el `.env`, crea las carpetas y descarga yt-dlp, ffmpeg/ffprobe y Deno a `bin\`, verificando el SHA-256 de cada uno.

El `Set-ExecutionPolicy` vale solo para esa ventana: hay que repetirlo cada vez que abras PowerShell para correr un script.

## 3. Configuración (`.env`)

Abrí `C:\STI-Catcher\app\.env` con el Bloc de notas y cambiá:

```ini
NODE_ENV=production
HOST=0.0.0.0
PORT=443
STORAGE_DIR=C:\STI-Catcher\storage
DATA_DIR=C:\STI-Catcher\data
LOG_DIR=C:\STI-Catcher\logs
```

- **PORT=443** permite entrar sin escribir el puerto (`https://servidor`). Si el 443 ya lo usa otro programa (por ejemplo IIS), elegí otro, como 8443. Para ver si está ocupado: `Get-NetTCPConnection -LocalPort 443 -State Listen`.
- Las demás variables están explicadas en el mismo archivo (tamaño máximo de subida, días de retención, trabajos simultáneos, etc.).
- `RETENTION_DAYS` (14 por defecto) borra los archivos más viejos y deja la entrada del historial como «expirado». `0` = no se borra nada.

Volvé a correr `.\scripts\setup.ps1` para que cree las carpetas nuevas.

### Aviso por mail de grabaciones (opcional)

Para que llegue un mail cuando termina una grabación, completá en el `.env` la casilla que manda y los destinatarios (D-099):

```ini
SMTP_HOST=c1831749.ferozo.com
SMTP_PORT=465
SMTP_SECURITY=ssl
SMTP_USER=soporte-notificaciones@capitanes.ar
SMTP_PASSWORD=          # la contraseña de la casilla: escribila solo acá
MAIL_TO=nombre@capitanes.ar, otro@capitanes.ar
```

Reiniciá el servicio y probalo en **Estado → Aviso por mail → Mandar mail de prueba**. Si falla, el mensaje dice qué revisar (usuario y contraseña, host o puerto, destinatarios).

### Recuperar la contraseña por mail (opcional)

Con el mail configurado, agregá la dirección con la que los compañeros entran a la app (la misma del certificado, paso 5). Va en el link que reciben para elegir una contraseña nueva (D-104):

```ini
PUBLIC_URL=https://192.168.3.115:3000
```

Reiniciá el servicio: en la pantalla de ingreso aparece **¿Olvidaste tu contraseña?**. El link vale 1 hora y una sola vez. Sin `PUBLIC_URL` esa opción no aparece y el log lo avisa al arrancar; queda la contraseña provisoria que pone un administrador en **Usuarios**.

## 4. Compilar

```powershell
npm ci
npm run build
```

### Crear el primer administrador

Para usar STI-Catcher hay que ingresar con una cuenta (D-104). La primera se crea acá, en el servidor, desde la carpeta del proyecto:

```powershell
npm run user:create-admin
```

Pide el mail (es el usuario para ingresar), el nombre que se va a ver en el historial y la contraseña dos veces (al menos 10 caracteres; no se muestra al escribirla). Usa el mismo `.env` y la misma base que el servicio, y se puede correr con el servicio andando. Si el servicio arranca sin ningún administrador, el log lo avisa. Las demás cuentas se crean desde la web: **Usuarios** (abajo, en la barra lateral, junto a tu nombre) → **Nueva cuenta**. Cada una arranca con una contraseña provisoria que la persona cambia al ingresar.

## 5. Certificado HTTPS

```powershell
.\scripts\new-certificate.ps1
```

- Descarga mkcert, crea una **autoridad de certificación (CA) propia de la red** y la marca como confiable en este equipo. Windows muestra un aviso de seguridad: aceptalo.
- Genera el certificado del servidor para el nombre del equipo, su IP y `localhost` en `C:\STI-Catcher\data\certs\`, y lo configura en el `.env`.
- Al final lista las direcciones válidas, por ejemplo `https://servidor-sti` y `https://192.168.3.115`.
- Si en la red hay un alias DNS (como `sti.empresa.local`), agregalo: `.\scripts\new-certificate.ps1 -Names sti.empresa.local -Force`.

La clave de la CA queda en el perfil de quien corrió el script (`bin\mkcert.exe -CAROOT` muestra dónde) y **no se copia a ningún lado**. Si alguien la obtiene, puede fabricar certificados que las PCs de la red aceptan.

## 6. Instalar el servicio

```powershell
.\scripts\install-service.ps1 -DisableSleep
```

Qué hace:

- **Instala el servicio «STI-Catcher»** (`sti-catcher`) con WinSW: arranca con el equipo y se reinicia solo si se cae.
- **Lo hace correr con la cuenta `NT SERVICE\sti-catcher`**, una cuenta propia, sin contraseña y con permisos mínimos. Solo puede escribir en storage, data y logs, y solo ella y los administradores pueden leer la clave del certificado.
- **Crea la regla de firewall** «STI-Catcher (TCP 443)» para las redes Privada y Dominio.
- **Con `-DisableSleep`**, configura el equipo para que no se suspenda ni hiberne enchufado. Un servidor suspendido deja a todos sin servicio. Revisá también que nadie apague la PC al irse.
- **Prueba** `https://localhost/api/health` al terminar.

Para ver qué haría sin instalar nada: `.\scripts\install-service.ps1 -DryRun`.

Si falla al arrancar, el motivo está en `C:\STI-Catcher\logs\service\sti-catcher.err.log`. Lo más común es un valor inválido en el `.env`: el mensaje dice cuál.

## 7. Probar desde el servidor

Abrí `https://<nombre-del-equipo>` en Chrome o Edge. Ingresá con la cuenta del paso 4. La página **Estado** tiene que mostrar las versiones de yt-dlp, ffmpeg y Deno, y el espacio en disco.

## 8. PCs cliente: instalar la CA

Cada PC que use STI-Catcher tiene que confiar en la CA del paso 5; si no, el navegador muestra «La conexión no es privada». Además, **grabar pantalla solo funciona por HTTPS válido**: es una restricción de los navegadores.

El archivo a instalar es `C:\STI-Catcher\data\certs\sti-catcher-ca.crt`. Es el certificado **público** de la CA y se puede compartir: dejalo en una carpeta compartida.

**Opción A — por GPO (dominio, recomendado).** En «Administración de directivas de grupo», editá una GPO que aplique a los equipos:

1. Configuración del equipo → Directivas → Configuración de Windows → Configuración de seguridad → Directivas de clave pública → **Entidades de certificación raíz de confianza**.
2. Clic derecho → Importar → `sti-catcher-ca.crt`.

Se aplica sola en el próximo reinicio, o al correr `gpupdate /force`.

**Opción B — en cada PC, con un comando** (PowerShell como administrador):

```powershell
certutil -addstore -f Root \\servidor\compartida\sti-catcher-ca.crt
```

**Opción C — en cada PC, a mano:**

1. Doble clic en `sti-catcher-ca.crt` → **Instalar certificado**.
2. Elegí **Equipo local**.
3. Elegí «Colocar todos los certificados en el siguiente almacén» → Examinar → **Entidades de certificación raíz de confianza** → Siguiente → Finalizar.

**Navegadores:** Chrome y Edge usan los certificados de Windows: no hace falta nada más (reiniciá el navegador). Firefox puede usar su propio almacén. Si sigue mostrando el aviso, en `about:config` poné `security.enterprise_roots.enabled` en `true`, o importá el archivo en Ajustes → Privacidad y seguridad → Certificados → Ver certificados → Autoridades → Importar.

Probá desde una PC cliente: descargar un video, convertir un archivo y grabar la pantalla.

## Mantenimiento

| Tarea                               | Cómo                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YouTube dejó de funcionar           | `.\scripts\update-ytdlp.ps1`. Es rutina: yt-dlp se actualiza seguido. No hace falta detener el servicio.                                                                                                                                                                                 |
| Actualizar la app                   | `git pull` (o copiar la versión nueva sin pisar `.env`), `npm ci`, `npm run build`, `Restart-Service sti-catcher`. Si cambiaron las carpetas del `.env`, volvé a correr `install-service.ps1`. La base de datos se actualiza sola al arrancar.                                           |
| Actualizar a la versión con login   | Una sola vez: después de compilar, `npm run user:create-admin` (paso 4) antes de reiniciar el servicio. Sin cuenta nadie puede ingresar. El historial anterior queda «sin cuenta»: se ve en «Todos» con la PC de siempre.                                                                |
| Alguien no puede ingresar           | Si se olvidó la contraseña, un admin le pone una provisoria en **Usuarios**. Tras 5 intentos fallidos la cuenta queda bloqueada 15 minutos (20 desde una misma PC bloquean esa PC). Reiniciar el servicio también lo destraba. El log registra cada ingreso fallido con el mail y la IP. |
| Cambió la IP o el nombre del equipo | `.\scripts\new-certificate.ps1 -Force`, después `.\scripts\install-service.ps1` (reaplica los permisos de la clave nueva). Las PCs cliente no necesitan nada: la CA es la misma.                                                                                                         |
| Renovar el certificado              | Vence a los 2 años y 3 meses: igual que el caso anterior. La fecha está en la salida de `new-certificate.ps1`.                                                                                                                                                                           |
| Ver si está andando                 | `Get-Service sti-catcher` o la página **Estado**.                                                                                                                                                                                                                                        |
| Reiniciar / detener                 | `Restart-Service sti-catcher` / `Stop-Service sti-catcher`. Al detenerlo, los trabajos en curso quedan como «interrumpido» y se pueden reintentar.                                                                                                                                       |
| Logs                                | `C:\STI-Catcher\logs\app.*.log` (la app, un archivo por día, se guardan 14) y `C:\STI-Catcher\logs\service\` (arranque y errores fatales).                                                                                                                                               |
| Copia de seguridad                  | Detené el servicio y copiá `C:\STI-Catcher\data` (base y certificados) y el `.env`. Los videos de `storage` son regenerables y se borran solos por retención.                                                                                                                            |
| Desinstalar                         | `.\scripts\uninstall-service.ps1`: quita el servicio y la regla de firewall. No borra datos.                                                                                                                                                                                             |

## Migrar a otro servidor

Para pasar STI-Catcher de un equipo (el «viejo») a otro (el «nuevo») conservando el historial. La base guarda las rutas de los archivos relativas a `STORAGE_DIR`, así que alcanza con copiar carpetas.

**Antes del día:** si los compañeros entran por un alias DNS (por ejemplo `sti.empresa.local`), la migración no se nota: al final solo se cambia a qué equipo apunta. Si entran por el nombre del equipo viejo, avisales la dirección nueva.

1. **En el nuevo:** pasos 1 a 4 de esta guía (Node, código, `setup.ps1`, `.env`, compilar). Para el `.env`, partí del `.env` del viejo y ajustá las carpetas. El mail (`SMTP_*`, `MAIL_TO`) queda igual.
2. **El certificado de la red.** Elegí una:
   - **CA nueva (más simple):** en el nuevo, `.\scripts\new-certificate.ps1` (paso 5). Después, cada PC cliente instala la CA nueva (paso 8).
   - **Llevar la CA del viejo (las PCs cliente no tocan nada):** en el viejo, `bin\mkcert.exe -CAROOT` muestra la carpeta de la CA. Copiá `rootCA.pem` y `rootCA-key.pem` a la carpeta que muestra el mismo comando en el nuevo, **antes** de correr `new-certificate.ps1` ahí. `rootCA-key.pem` es secreto: pasalo por un pendrive (no por mail ni carpeta compartida) y borralo del pendrive al terminar.
   - Si hay alias DNS, sumalo: `.\scripts\new-certificate.ps1 -Names sti.empresa.local`.
3. **En el viejo:** `Stop-Service sti-catcher`. Desde acá no se puede usar la app hasta terminar.
4. **Copiá del viejo al nuevo:**
   - `DATA_DIR\sti-catcher.db` (y `sti-catcher.db-wal` / `sti-catcher.db-shm` si están) al `DATA_DIR` del nuevo. **No** copies `certs\` ni `sti-catcher.pid`.
   - `STORAGE_DIR\files` y `STORAGE_DIR\recordings`, si querés conservar los archivos. Si no, el historial queda y los archivos figuran como «expirado».
5. **En el nuevo:** `.\scripts\install-service.ps1 -DisableSleep` (paso 6). Abrí **Estado**, revisá el historial y mandá el mail de prueba.
6. **En el viejo:** `.\scripts\uninstall-service.ps1`. Si llevaste la CA y el viejo deja de ser de confianza, borrá su carpeta `-CAROOT`.
7. **Alias DNS:** que apunte a la IP del nuevo. Probá desde una PC cliente: descargar, convertir y grabar.

## Problemas comunes

- **«La conexión no es privada»:** a esa PC le falta la CA (paso 8), o se está entrando por un nombre que no está en el certificado. Los nombres válidos son los que listó `new-certificate.ps1`.
- **«Grabar pantalla» dice que hace falta HTTPS:** se entró por `http://` o por una dirección con aviso de certificado. Usá una de las direcciones `https://` válidas.
- **Desde otra PC no carga nada:**
  - Revisá que el servicio esté corriendo.
  - Revisá que `HOST=0.0.0.0`.
  - La red del servidor tiene que ser Privada o Dominio: el instalador avisa si es Pública.
  - Probá la regla de firewall desde la PC cliente: `Test-NetConnection servidor -Port 443`.
- **El servicio se detiene solo:** mirá `logs\service\sti-catcher.err.log`. Windows lo reinicia a los 10 s, a los 30 s y después cada 2 minutos.
- **«No hay espacio suficiente»:** se alcanzó `MIN_FREE_DISK_GB`. Bajá `RETENTION_DAYS` o liberá espacio en el disco de `STORAGE_DIR`.
