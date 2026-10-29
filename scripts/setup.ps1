<#
.SYNOPSIS
  Prepara STI-Catcher en este equipo.

.DESCRIPTION
  1. Verifica que Node.js (24 o superior) esté instalado para todos los usuarios.
  2. Crea .env a partir de .env.example si no existe.
  3. Crea las carpetas STORAGE_DIR, DATA_DIR, LOG_DIR y BIN_DIR.
  4. Descarga a BIN_DIR, desde sus releases oficiales y verificando el SHA-256:
       - yt-dlp.exe           (github.com/yt-dlp/yt-dlp)
       - ffmpeg.exe y ffprobe (gyan.dev, build "essentials")
       - deno.exe             (github.com/denoland/deno)

  No modifica un .env existente. Se puede correr las veces que haga falta.

.PARAMETER AllowUserNode
  Acepta un Node.js instalado solo para el usuario actual. Solo para desarrollo:
  el servicio de Windows corre con otra cuenta y no lo encontraría.

.PARAMETER Force
  Vuelve a descargar los binarios aunque ya existan.

.EXAMPLE
  .\scripts\setup.ps1
.EXAMPLE
  .\scripts\setup.ps1 -AllowUserNode     # PC de desarrollo
#>
[CmdletBinding()]
param(
  [switch]$AllowUserNode,
  [switch]$Force
)

. "$PSScriptRoot\common.ps1"

$MinNodeMajor = 24

# --- 1. Node.js ---------------------------------------------------------------
Write-Step 'Verificando Node.js'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw "No se encontró Node.js. Instalalo para todos los usuarios (en una consola de administrador):`n  winget install --id OpenJS.NodeJS.LTS --scope machine"
}
$nodePath = $nodeCommand.Source
$nodeVersion = (& $nodePath -p 'process.versions.node').Trim()
if ([int]$nodeVersion.Split('.')[0] -lt $MinNodeMajor) {
  throw "Node.js $nodeVersion es demasiado viejo: se necesita $MinNodeMajor o superior."
}

$machineDirs = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
$isMachineWide = @($machineDirs | Where-Object {
    $nodePath.StartsWith($_.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
  }).Count -gt 0

if ($isMachineWide) {
  Write-Ok "Node.js $nodeVersion para todos los usuarios ($nodePath)"
}
elseif ($AllowUserNode) {
  Write-Warning "Node.js $nodeVersion está instalado solo para este usuario ($nodePath). Sirve para desarrollo, pero el servicio de Windows no lo va a encontrar."
}
else {
  throw @"
Node.js está instalado solo para este usuario:
  $nodePath
El servicio de Windows corre con otra cuenta y no lo ve. Instalalo para todos los usuarios
(en una consola de administrador):
  winget install --id OpenJS.NodeJS.LTS --scope machine
En una PC de desarrollo podés seguir con:
  .\scripts\setup.ps1 -AllowUserNode
"@
}

# --- 2. .env ------------------------------------------------------------------
Write-Step 'Configuración (.env)'
$envFile = Get-EnvFilePath
if (Test-Path -LiteralPath $envFile) {
  Write-Skip "Ya existe $envFile (no se modifica)"
}
else {
  Copy-Item -LiteralPath (Join-Path $RepoRoot '.env.example') -Destination $envFile
  Write-Ok "Creado $envFile a partir de .env.example. Revisá los valores."
}
$envValues = Read-EnvFile $envFile
$envDir = Split-Path -Parent $envFile

# --- 3. Carpetas --------------------------------------------------------------
Write-Step 'Carpetas'
$dirs = @{}
foreach ($key in 'STORAGE_DIR', 'DATA_DIR', 'LOG_DIR', 'BIN_DIR') {
  if (-not $envValues[$key]) { throw "Falta $key en $envFile." }
  $dirs[$key] = Resolve-ConfigPath $envValues[$key] $envDir
  New-Item -ItemType Directory -Force -Path $dirs[$key] | Out-Null
  Write-Ok ("{0,-12} {1}" -f $key, $dirs[$key])
}
$binDir = $dirs['BIN_DIR']

# --- 4. Binarios --------------------------------------------------------------
$tempDir = Join-Path ([IO.Path]::GetTempPath()) ('sti-setup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
  Write-Step 'yt-dlp'
  $ytdlp = Join-Path $binDir 'yt-dlp.exe'
  if ((Test-Path -LiteralPath $ytdlp) -and -not $Force) {
    Write-Skip 'Ya está instalado (usá -Force para volver a descargarlo).'
  }
  else {
    $base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
    $download = Join-Path $tempDir 'yt-dlp.exe'
    Invoke-VerifiedDownload "$base/yt-dlp.exe" "$base/SHA2-256SUMS" 'yt-dlp.exe' $download
    Move-Item -LiteralPath $download -Destination $ytdlp -Force
    Write-Ok 'yt-dlp.exe instalado'
  }

  Write-Step 'ffmpeg y ffprobe'
  $ffmpeg = Join-Path $binDir 'ffmpeg.exe'
  $ffprobe = Join-Path $binDir 'ffprobe.exe'
  if ((Test-Path -LiteralPath $ffmpeg) -and (Test-Path -LiteralPath $ffprobe) -and -not $Force) {
    Write-Skip 'Ya están instalados (usá -Force para volver a descargarlos).'
  }
  else {
    $zipUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
    $zip = Join-Path $tempDir 'ffmpeg.zip'
    Invoke-VerifiedDownload $zipUrl "$zipUrl.sha256" '' $zip
    $extractDir = Join-Path $tempDir 'ffmpeg'
    Expand-Archive -LiteralPath $zip -DestinationPath $extractDir
    foreach ($exe in 'ffmpeg.exe', 'ffprobe.exe') {
      $source = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter $exe | Select-Object -First 1
      if (-not $source) { throw "No se encontró $exe dentro del zip de ffmpeg." }
      Copy-Item -LiteralPath $source.FullName -Destination (Join-Path $binDir $exe) -Force
    }
    Write-Ok 'ffmpeg.exe y ffprobe.exe instalados'
  }

  Write-Step 'Deno'
  $deno = Join-Path $binDir 'deno.exe'
  if ((Test-Path -LiteralPath $deno) -and -not $Force) {
    Write-Skip 'Ya está instalado (usá -Force para volver a descargarlo).'
  }
  else {
    $zipName = 'deno-x86_64-pc-windows-msvc.zip'
    $base = 'https://github.com/denoland/deno/releases/latest/download'
    $zip = Join-Path $tempDir $zipName
    Invoke-VerifiedDownload "$base/$zipName" "$base/$zipName.sha256sum" $zipName $zip
    $extractDir = Join-Path $tempDir 'deno'
    Expand-Archive -LiteralPath $zip -DestinationPath $extractDir
    Copy-Item -LiteralPath (Join-Path $extractDir 'deno.exe') -Destination $deno -Force
    Write-Ok 'deno.exe instalado'
  }
}
finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

# --- Resumen ------------------------------------------------------------------
Write-Step 'Versiones instaladas'
Write-Host ('    yt-dlp   ' + (& (Join-Path $binDir 'yt-dlp.exe') --version))
Write-Host ('    ffmpeg   ' + ((& (Join-Path $binDir 'ffmpeg.exe') -hide_banner -version) | Select-Object -First 1))
Write-Host ('    ffprobe  ' + ((& (Join-Path $binDir 'ffprobe.exe') -hide_banner -version) | Select-Object -First 1))
Write-Host ('    deno     ' + ((& (Join-Path $binDir 'deno.exe') --version) | Select-Object -First 1))

Write-Host "`nListo. Próximos pasos:" -ForegroundColor Green
Write-Host '    npm install'
Write-Host '    npm run dev        (desarrollo: http://127.0.0.1:5173)'
