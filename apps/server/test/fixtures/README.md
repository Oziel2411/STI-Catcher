# Fixtures

Salidas **reales** de las herramientas, capturadas el 29/10/2026 en Windows 10 con yt-dlp 2026.10.26, ffmpeg/ffprobe 9.0.2 (gyan.dev) y Deno 2.9.8. Los tests no acceden a la red: usan estos archivos.

| Archivo                                                   | Origen                                                                                                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ytdlp-probe-me-at-the-zoo.json`                          | `yt-dlp -J --no-playlist` de https://www.youtube.com/watch?v=jNQXAC9IVRw (19 s; H.264 solo hasta 240p, AV1/VP9 también).                                             |
| `ytdlp-probe-big-buck-bunny.json`                         | Ídem para https://www.youtube.com/watch?v=aqz-KE-bpKQ (Blender Foundation, CC-BY). H.264 hasta 1080p; 1440p y 2160p **solo** VP9/AV1: es el caso del aviso de codec. |
| `ytdlp-download-{compat,quality,mp3}.{stdout,stderr}.txt` | Descargas reales de "Me at the zoo" con los argumentos de `buildDownloadArgs` (progreso por stdout, postproceso por stderr).                                         |
| `ytdlp-error-*.txt`                                       | stderr real de yt-dlp: video inexistente, URL no soportada (con `--use-extractors default,-generic`) e id de YouTube truncado.                                       |
| `ffprobe-sample-{mp4,mp3}.json`                           | `ffprobe -v error -print_format json -show_format -show_streams` sobre archivos generados con ffmpeg (H.264/AAC 1280×720 y MP3).                                     |

Los JSON de `yt-dlp -J` están **reducidos**: se conservaron solo los campos que usa la app (los originales pesan 100–180 KB). Los valores no se modificaron.

Los mensajes de error que no se pudieron reproducir (video privado, restricción de edad o geográfica, verificación anti-bot) se testean con los textos exactos que arma yt-dlp (`yt_dlp/extractor/youtube/_video.py`).
