# STI-Catcher

Web app interna para **descargar video por URL**, **grabar la pantalla** desde el navegador y **convertir archivos** entre formatos de video y audio, con historial de todo lo procesado.

Corre en una PC con Windows que hace de servidor en la red interna. Se usa desde el navegador, sin login.

> Usar solo con contenido propio o con autorización.

## Requisitos

- Windows 10 u 11.
- Node.js 24 LTS. En el servidor, instalado **para todos los usuarios**:
  `winget install --id OpenJS.NodeJS.LTS --scope machine`
- yt-dlp, ffmpeg/ffprobe y Deno: los descarga `scripts/setup.ps1`.

## Desarrollo

```powershell
.\scripts\setup.ps1 -AllowUserNode   # binarios en .\bin, .env y carpetas
npm install
npm run dev
```

- Web: http://127.0.0.1:5173 (Vite, con proxy de `/api` al server).
- API: http://127.0.0.1:3000 (por ejemplo `/api/health`).

Antes de cada commit: `npm run check` (tipos, lint, formato y tests).

## Producción

Instalación en el servidor, HTTPS y servicio de Windows: `docs/DEPLOY.md` (Fase 7).

## Documentación

- [SPEC.md](SPEC.md): especificación.
- [docs/DECISIONS.md](docs/DECISIONS.md): decisiones técnicas y su porqué.
- [CLAUDE.md](CLAUDE.md): comandos y convenciones del proyecto.
# STI-Catcher
