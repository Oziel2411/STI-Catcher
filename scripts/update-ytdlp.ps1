<#
.SYNOPSIS
  Actualiza yt-dlp.exe a la última versión oficial, sin detener el servicio.

.DESCRIPTION
  yt-dlp se rompe cada vez que un sitio cambia (YouTube, a menudo): actualizarlo
  es mantenimiento de rutina. Si la app muestra "yt-dlp está desactualizado",
  hay que correr este script.

  Windows no deja reemplazar ni borrar un .exe que se está ejecutando, pero sí
  renombrarlo (D-042). Por eso:
    1. Borra yt-dlp.old*.exe de corridas anteriores (si alguno sigue en uso, lo
       deja y lo intenta la próxima vez).
    2. Descarga la última versión a yt-dlp.new.exe y verifica el SHA-256 publicado.
    3. Ejecuta yt-dlp.new.exe --version para comprobar que funciona.
    4. Renombra yt-dlp.exe → yt-dlp.old.exe y yt-dlp.new.exe → yt-dlp.exe.

  Los trabajos que están corriendo siguen con el ejecutable viejo (ya cargado
  en memoria); los nuevos usan el nuevo. No hace falta detener el servicio.

.PARAMETER Force
  Reemplaza el ejecutable aunque ya sea la última versión (p. ej. si se dañó).

.EXAMPLE
  .\scripts\update-ytdlp.ps1
.EXAMPLE
  .\scripts\update-ytdlp.ps1 -Force     # reinstalar la misma versión
#>
[CmdletBinding()]
param(
  [switch]$Force
)

. "$PSScriptRoot\common.ps1"

$envFile = Get-EnvFilePath
if (-not (Test-Path -LiteralPath $envFile)) { throw "No se encontró $envFile. Corré primero scripts\setup.ps1." }
$ytdlp = Get-YtdlpPath $envFile
$dir = Split-Path -Parent $ytdlp
$newExe = Join-Path $dir 'yt-dlp.new.exe'
$oldExe = Join-Path $dir 'yt-dlp.old.exe'

function Get-YtdlpVersion([string]$Path) {
  # Capturar toda la salida antes de mirarla: con "| Select-Object -First 1",
  # PowerShell 5.1 corta el proceso y $LASTEXITCODE queda en -1 (medido).
  $output = @(& $Path --version 2>$null)
  $first = if ($output.Count -gt 0) { [string]$output[0] } else { '' }
  if ($LASTEXITCODE -ne 0 -or -not ($first -match '^\d{4}\.\d{2}\.\d{2}')) { return $null }
  return $first.Trim()
}

# --- 1. Restos de actualizaciones anteriores --------------------------------------
Write-Step 'Limpieza de versiones anteriores'
foreach ($leftover in @(Get-ChildItem -LiteralPath $dir -Filter 'yt-dlp.old*.exe') + @(Get-ChildItem -LiteralPath $dir -Filter 'yt-dlp.new.exe')) {
  try {
    Remove-Item -LiteralPath $leftover.FullName -Force
    Write-Ok "Borrado $($leftover.Name)"
  }
  catch {
    # Un trabajo largo que arrancó antes de la actualización anterior todavía lo usa.
    Write-Warning "$($leftover.Name) sigue en uso por un trabajo en curso. Se borrará en la próxima actualización."
  }
}

$current = if (Test-Path -LiteralPath $ytdlp) { Get-YtdlpVersion $ytdlp } else { $null }
Write-Host "    Versión instalada: $(if ($current) { $current } else { 'ninguna' })"

# --- 2. Descarga verificada --------------------------------------------------------
Write-Step 'Descarga de la última versión'
$base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
Invoke-VerifiedDownload "$base/yt-dlp.exe" "$base/SHA2-256SUMS" 'yt-dlp.exe' $newExe

# --- 3. Prueba ---------------------------------------------------------------------
$latest = Get-YtdlpVersion $newExe
if (-not $latest) {
  Remove-Item -LiteralPath $newExe -Force -ErrorAction SilentlyContinue
  throw 'La versión descargada no respondió a --version. No se cambió nada.'
}
Write-Ok "La nueva versión funciona: $latest"

if ($latest -eq $current -and -not $Force) {
  Remove-Item -LiteralPath $newExe -Force
  Write-Host "`nYa estaba actualizado ($current). No se cambió nada." -ForegroundColor Green
  exit 0
}

# --- 4. Reemplazo por renombre --------------------------------------------------------
Write-Step 'Reemplazo'
# Si un yt-dlp.old.exe quedó en uso (paso 1), se usa un nombre con fecha para no pisarlo.
$oldTarget = if (Test-Path -LiteralPath $oldExe) { Join-Path $dir ("yt-dlp.old.{0}.exe" -f (Get-Date -Format 'yyyyMMddHHmmss')) } else { $oldExe }
if (Test-Path -LiteralPath $ytdlp) {
  Rename-Item -LiteralPath $ytdlp -NewName (Split-Path -Leaf $oldTarget)
}
try {
  Rename-Item -LiteralPath $newExe -NewName (Split-Path -Leaf $ytdlp)
}
catch {
  # Volver atrás: que nunca quede el sistema sin yt-dlp.exe.
  if (Test-Path -LiteralPath $oldTarget) { Rename-Item -LiteralPath $oldTarget -NewName (Split-Path -Leaf $ytdlp) }
  throw "No se pudo poner la nueva versión en su lugar: $($_.Exception.Message). Se restauró la anterior."
}

Write-Ok "yt-dlp actualizado: $(if ($current) { $current } else { 'ninguna' }) -> $(Get-YtdlpVersion $ytdlp)"
Write-Host "`nListo. La página Estado muestra la versión nueva al tocar 'Actualizar'." -ForegroundColor Green
