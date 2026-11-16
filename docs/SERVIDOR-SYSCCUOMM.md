# Servidor final: SRV-SYSCCUOMM

Plan concreto para instalar STI-Catcher en SRV-SYSCCUOMM y dejar de usar SISTEMAS2-PC (192.168.3.115), donde hoy corre de forma provisoria. Los pasos generales están en [DEPLOY.md](DEPLOY.md); acá va lo propio de este equipo.

**Fecha objetivo:** la semana del 23 de noviembre de 2026.

## Relevamiento (16/11/2026)

Hecho con `scripts\survey-server.ps1`, como administrador, en el equipo.

| Tema      | Dato                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Nombre    | **SRV-SYSCCUOMM** (no «SYSCCUOMM»: por eso antes no resolvía). Grupo de trabajo CAPITANES, sin dominio.                          |
| Windows   | 10 Pro 22H2 (19045.6466), 64 bits, español. Igual que SISTEMAS2-PC: no hace falta adaptar nada para Windows Server.              |
| Equipo    | Gigabyte B250M-D3H, Intel Core i5-7500 (4 núcleos), 8 GB de RAM.                                                                 |
| GPU       | Intel HD Graphics 630 (Quick Sync), driver de 2020. Sin NVIDIA: la compresión usa QSV o CPU.                                     |
| Discos    | C: SSD NVMe 465 GB (415 libres) · D: «Almacenamiento» HDD 931 GB (vacío) · E: «BACKUPS» HDD 931 GB (vacío).                      |
| Red       | Un adaptador con dos IPs fijas: **192.168.3.78** y 192.168.5.191. DNS 8.8.8.8 (no hay DNS interno). Perfil Privada.              |
| Nombre    | Desde SISTEMAS2-PC, `srv-sysccuomm` resuelve a las dos IPs (por la red local, no por DNS). Hay que probarlo desde otras PCs.     |
| Puertos   | 80 y 443 los usa Apache (httpd). También se usan 3306 (MySQL), 3001, 5173 y 8765 (otros sistemas). **3000 libre.**               |
| Software  | Node 26.13 para todos los usuarios ✓, winget ✓, .NET 4.8 ✓. **Sin git.**                                                         |
| Seguridad | **ESET Security** (Defender pasivo). Sin AppLocker, WDAC ni GPOs. Política de ejecución sin forzar.                              |
| Internet  | Salida directa, sin proxy: GitHub, gyan.dev, npm, nodejs.org y YouTube OK. SMTP de Ferozo (465 y 587) OK.                        |
| Migración | Llega a SISTEMAS2-PC por 3000 y 445 (carpetas compartidas).                                                                      |
| Energía   | No se suspende. Hora de time.windows.com, zona Buenos Aires.                                                                     |
| Firewall  | Desde SISTEMAS2-PC **no** se llega al 443 de Apache, aunque escucha: algo (probablemente el firewall de ESET) filtra la entrada. |

Respuestas del responsable de la app:

- **Historial:** no se pasa. **Cuentas:** sí, con sus contraseñas de hoy.
- **Clientes:** solo desde la red 192.168.3.x.
- **Certificado:** CA nueva (cada PC cliente instala el certificado nuevo).
- **Carpetas:** nuevas.
- **Equipo:** lo administra Juan Pablo (backups incluidos); el administrador de la app es Oziel.
- **Restricción:** **sin reinicios.** El equipo ya corre otros sistemas (Carli, en el 8765, y los de los puertos 3001, 3306 y 5173). Nada de este plan reinicia el equipo ni toca esos puertos.

## Decisiones para este equipo

| Qué          | Valor                                                                                             | Por qué                                                               |
| ------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Puerto       | `PORT=3000`                                                                                       | 443 es de Apache; 3000 está libre y es el mismo de hoy.               |
| Dirección    | **`https://192.168.3.78:3000`** (y `https://srv-sysccuomm:3000` si el nombre resuelve en las PCs) | Sin DNS interno, la IP es lo único seguro. **A confirmar.**           |
| `PUBLIC_URL` | `https://192.168.3.78:3000`                                                                       | El link para recuperar la contraseña tiene que abrir en cualquier PC. |
| Código       | `C:\STI-Catcher\app` (SSD)                                                                        | Arranque y `node_modules` en el disco rápido.                         |
| Datos        | `D:\STI-Catcher\storage`, `D:\STI-Catcher\data`, `D:\STI-Catcher\logs`                            | D: está vacío y es el disco de almacenamiento.                        |
| Backups      | `E:\STI-Catcher` (lo administra Juan Pablo)                                                       | E: es el disco de backups.                                            |
| Certificado  | CA nueva con mkcert; incluye `srv-sysccuomm`, 192.168.3.78, 192.168.5.191 y localhost             | `new-certificate.ps1` toma el nombre y todas las IPs solo.            |
| Suspensión   | No hace falta `-DisableSleep`                                                                     | Ya está en «nunca».                                                   |
| Trabajos     | `MAX_CONCURRENT_JOBS=2`                                                                           | 4 núcleos, compartidos con los otros sistemas del equipo.             |

## Antes del día (no corta el servicio actual)

### A. Con Juan Pablo (o quien administre ESET)

1. **Excepción en ESET** para `C:\STI-Catcher\app\bin\` (yt-dlp, ffmpeg, ffprobe, deno, mkcert) y `C:\STI-Catcher\app\service\` (WinSW). Son ejecutables descargados de internet y un antivirus puede ponerlos en cuarentena.
2. **Firewall de ESET:** permitir TCP **3000** de entrada desde **192.168.3.0/24**. La regla de Windows la crea `install-service.ps1`, pero si ESET filtra la entrada (como pasa con el 443 de Apache), no alcanza.
3. **Windows Update:** que no reinicie solo (horas activas o pausar), porque el equipo no se puede reiniciar. El driver de video de 2020 también conviene actualizarlo, pero solo en una ventana con reinicio acordada con Carli: no es requisito.

### B. Llevar el código

El servidor no tiene git y la versión a instalar está solo en SISTEMAS2-PC (`main` tiene commits que no están en GitHub). Se lleva un ZIP:

1. En SISTEMAS2-PC, en la carpeta del proyecto, con `main` actualizado (incluida la rama de este plan, si se mergeó):

   ```powershell
   git archive --format=zip -o C:\temp\sti-catcher.zip main
   ```

2. Copiá `sti-catcher.zip` a SRV-SYSCCUOMM (pendrive o carpeta compartida) y descomprimilo en `C:\STI-Catcher\app`. Tienen que quedar `C:\STI-Catcher\app\package.json`, `scripts\`, `apps\`, etc. (no una subcarpeta más).
3. En SRV-SYSCCUOMM, PowerShell como administrador:

   ```powershell
   Get-ChildItem -Recurse C:\STI-Catcher\app | Unblock-File
   ```

### C. Instalar (pasos 2 a 6 de DEPLOY.md)

Todo en PowerShell **como administrador**, en `C:\STI-Catcher\app`, después de `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`.

1. `.\scripts\setup.ps1`: crea el `.env` y descarga los binarios. Node 26.13 ya está.
2. Editá `C:\STI-Catcher\app\.env` con el Bloc de notas:

   ```ini
   NODE_ENV=production
   HOST=0.0.0.0
   PORT=3000
   STORAGE_DIR=D:\STI-Catcher\storage
   DATA_DIR=D:\STI-Catcher\data
   LOG_DIR=D:\STI-Catcher\logs
   PUBLIC_URL=https://192.168.3.78:3000
   ```

   Y el mail, igual que en SISTEMAS2-PC: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `MAIL_FROM`. **`SMTP_PASSWORD` la escribís vos** a mano (no la copies por mail ni la dejes en otro archivo).

3. `.\scripts\setup.ps1` de nuevo (crea las carpetas de D:).
4. `npm ci` y `npm run build`.
5. `.\scripts\new-certificate.ps1`: aceptá el aviso de seguridad. Tiene que listar `https://srv-sysccuomm:3000` y `https://192.168.3.78:3000`. La clave de la CA queda en el perfil de **Soporte**: cualquiera que entre con esa cuenta puede leerla. Si Soporte es una cuenta compartida, conviene correr este paso con una cuenta personal de administrador.
6. Confirmá que el 3000 sigue libre:

   ```powershell
   Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
   ```

   No tiene que mostrar nada.

7. `.\scripts\install-service.ps1` (sin `-DisableSleep`). Al final tiene que decir «Responde en https://localhost:3000/api/health».

Hasta el día del corte, la base de SRV-SYSCCUOMM está vacía: para probar, creá una cuenta con `npm run user:create-admin` (se pisa con la base migrada en el paso E).

### D. Probar antes del corte

1. En el servidor: `https://localhost:3000` → **Estado**: versiones de yt-dlp, ffmpeg y Deno, y el disco D:.
2. Desde una PC de la red 192.168.3.x:

   ```powershell
   Test-NetConnection 192.168.3.78 -Port 3000
   ```

   Tiene que dar `TcpTestSucceeded : True`. Si da `False`, falta el permiso en el firewall de ESET (paso A.2).

3. En esa PC, `ping srv-sysccuomm`: si responde, también se puede entrar por nombre.
4. Instalá la CA nueva en esa PC (`D:\STI-Catcher\data\certs\sti-catcher-ca.crt`, opción B o C del paso 8 de DEPLOY.md: no hay dominio, así que no hay GPO) y probá descargar, convertir, comprimir y grabar.
5. **Compresión:** revisá en el log de la app (`D:\STI-Catcher\logs\app.*.log`) qué encoder eligió al arrancar. En SISTEMAS2-PC, Quick Sync anda desde el escritorio pero no estaba probado bajo el servicio.

## El día del corte

Corte de unos minutos. Avisá antes a los compañeros.

1. **En SRV-SYSCCUOMM:** `Stop-Service sti-catcher`.
2. **En SISTEMAS2-PC:** `Stop-Service sti-catcher`. Desde acá nadie usa la app hasta el paso 6.
3. Copiá de SISTEMAS2-PC a `D:\STI-Catcher\data\` de SRV-SYSCCUOMM: `sti-catcher.db` (y `sti-catcher.db-wal` / `sti-catcher.db-shm` si están). **No** copies `certs\`, `sti-catcher.pid` ni `storage\`.
4. **Dejar solo las cuentas:** borrar el historial de la base copiada, conservando usuarios y contraseñas. **Pendiente:** hace falta un comando nuevo (ver [Cambios propuestos](#cambios-propuestos)). Sin él, la alternativa es base vacía y crear las cuentas de nuevo en **Usuarios**.
5. **En SRV-SYSCCUOMM:** `Start-Service sti-catcher`. Entrá con tu cuenta de siempre y revisá **Usuarios**. **Estado → Mandar mail de prueba.**
6. Avisá la dirección nueva: `https://192.168.3.78:3000`. Cada PC tiene que instalar la CA nueva antes de entrar (si no, ve «La conexión no es privada» y no puede grabar).
7. **SISTEMAS2-PC:** dejalo detenido unos días por si hay que volver atrás (`Start-Service sti-catcher` ahí). Cuando esté todo bien: `.\scripts\uninstall-service.ps1`.

## Después

- **Backups** (Juan Pablo): `D:\STI-Catcher\data` (base y certificados) y `C:\STI-Catcher\app\.env`, a `E:\STI-Catcher`. Copiar la base con el servicio andando puede dejar una copia inconsistente: detenerlo un momento, o esperar la propuesta de backup automático.
- **Actualizar la app:** nuevo ZIP como en el paso B, descomprimido encima **sin pisar `.env`**, `npm ci`, `npm run build`, `Restart-Service sti-catcher`.
- **Cambio de IP:** `new-certificate.ps1 -Force` e `install-service.ps1` (DEPLOY.md, Mantenimiento).

## Riesgos y pendientes

| Tema                    | Qué pasa                                                                                                                                                     | Quién             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| Red 192.168.5.x         | La regla de firewall abre el 3000 para cualquier IP en redes Privadas. La red 5.x también es Privada: desde ahí también se llega, aunque no se use.          | propuesta abajo   |
| Dos puertas de enlace   | El adaptador tiene 192.168.3.2 y 192.168.5.1. No afecta a la app, pero puede dar salidas a internet erráticas.                                               | Juan Pablo        |
| Sin DNS interno         | El nombre se resuelve por la red local, no por DNS. Si falla en alguna PC, se entra por IP.                                                                  | —                 |
| Reinicios               | Windows Update o un corte de luz reinician el equipo: el servicio arranca solo (inicio automático retrasado), y los trabajos en curso quedan «interrumpido». | Juan Pablo        |
| Driver de video de 2020 | Quick Sync puede fallar o rendir menos. Si falla, la compresión va por CPU (más lenta).                                                                      | ventana con Carli |
| ESET                    | Puede poner en cuarentena un binario después de una actualización de yt-dlp. Síntoma: la página Estado no muestra la versión.                                | Juan Pablo        |

## Cambios propuestos

Esperan el OK antes de hacerse:

1. **Comando para dejar solo las cuentas** (`npm run db:keep-accounts`): sobre una base copiada, borra trabajos, grabaciones, avisos, programaciones, sesiones y links de recuperación, y deja usuarios con sus contraseñas. Se niega a correr si el servicio está usando esa base y pide confirmación escrita. Hace falta para el paso 4 del corte.
2. **`install-service.ps1 -RemoteAddress 192.168.3.0/24`**: limita la regla de firewall a la red de los clientes.
