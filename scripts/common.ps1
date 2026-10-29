<#
.SYNOPSIS
  Funciones compartidas por los scripts de STI-Catcher. Se carga con:
    . "$PSScriptRoot\common.ps1"
#>

$ErrorActionPreference = 'Stop'
# En PowerShell 5.1 la barra de progreso hace que Invoke-WebRequest sea mucho más lento.
$ProgressPreference = 'SilentlyContinue'
# PowerShell 5.1 puede no tener TLS 1.2 habilitado por defecto (GitHub lo exige).
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$RepoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "    OK  $Message" -ForegroundColor Green }
function Write-Skip([string]$Message) { Write-Host "    --  $Message" -ForegroundColor DarkGray }

# Lee un .env simple (CLAVE=valor). Ignora comentarios y líneas vacías.
function Read-EnvFile([string]$Path) {
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      $value = $Matches[2]
      if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $values[$Matches[1]] = $value
    }
  }
  return $values
}

# Igual que el server: las rutas relativas se resuelven contra la carpeta del .env.
function Resolve-ConfigPath([string]$Value, [string]$BaseDir) {
  if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
  return [IO.Path]::GetFullPath((Join-Path $BaseDir $Value))
}

# Ruta del .env: STI_ENV_FILE si está definida, si no <repo>\.env (igual que el server).
function Get-EnvFilePath {
  if ($env:STI_ENV_FILE) { return [IO.Path]::GetFullPath($env:STI_ENV_FILE) }
  return Join-Path $RepoRoot '.env'
}

# Ruta de yt-dlp.exe según el .env: YTDLP_PATH si está, si no <BIN_DIR>\yt-dlp.exe.
function Get-YtdlpPath([string]$EnvFile) {
  $values = Read-EnvFile $EnvFile
  $baseDir = Split-Path -Parent $EnvFile
  if ($values['YTDLP_PATH']) { return Resolve-ConfigPath $values['YTDLP_PATH'] $baseDir }
  if (-not $values['BIN_DIR']) { throw "Falta BIN_DIR en $EnvFile." }
  return Join-Path (Resolve-ConfigPath $values['BIN_DIR'] $baseDir) 'yt-dlp.exe'
}

# Extrae el SHA-256 esperado de un archivo de sumas. Soporta los tres formatos:
#   yt-dlp: "<hash>  yt-dlp.exe" (una línea por archivo)
#   gyan:   "<hash>" (solo el hash)
#   deno:   salida de Get-FileHash ("Hash : <hash>")
function Get-ExpectedHash([string]$SumsText, [string]$FileName) {
  $text = $SumsText
  if ($FileName) {
    $line = $SumsText -split "`r?`n" |
      Where-Object { $_ -match "\s\*?$([regex]::Escape($FileName))\s*$" } |
      Select-Object -First 1
    if ($line) { $text = $line }
  }
  $found = [regex]::Matches($text, '\b[0-9A-Fa-f]{64}\b')
  if ($found.Count -ne 1) { throw "No se pudo leer el SHA-256 esperado para '$FileName'." }
  return $found[0].Value.ToUpperInvariant()
}

function Get-TextContent([string]$Url) {
  $content = (Invoke-WebRequest -Uri $Url -UseBasicParsing).Content
  if ($content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($content) }
  return [string]$content
}

# Descarga un archivo y verifica su SHA-256 contra el publicado. Si no coincide, lo borra y falla.
function Invoke-VerifiedDownload([string]$Url, [string]$SumsUrl, [string]$SumsFileName, [string]$OutFile) {
  Write-Host "    Descargando $Url"
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
  $expected = Get-ExpectedHash (Get-TextContent $SumsUrl) $SumsFileName
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutFile).Hash.ToUpperInvariant()
  if ($actual -ne $expected) {
    Remove-Item -LiteralPath $OutFile -Force
    throw "El SHA-256 de $Url no coincide (esperado $expected, obtenido $actual). Se descartó la descarga."
  }
  Write-Host "    SHA-256 verificado."
}

# Descarga un archivo y verifica un SHA-256 fijado en el script (para releases que
# no publican sumas). Si no coincide, lo borra y falla.
function Invoke-PinnedDownload([string]$Url, [string]$Sha256, [string]$OutFile) {
  Write-Host "    Descargando $Url"
  $partial = "$OutFile.download"
  Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash.ToUpperInvariant()
  if ($actual -ne $Sha256.ToUpperInvariant()) {
    Remove-Item -LiteralPath $partial -Force
    throw "El SHA-256 de $Url no coincide (esperado $Sha256, obtenido $actual). Se descartó la descarga."
  }
  Move-Item -LiteralPath $partial -Destination $OutFile -Force
  Write-Host "    SHA-256 verificado."
}

# True si el archivo existe y tiene el SHA-256 esperado.
function Test-FileHash([string]$Path, [string]$Sha256) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash -eq $Sha256.ToUpperInvariant()
}

# Node.js instalado para todos los usuarios (en Program Files): el servicio corre
# con otra cuenta y no puede usar un Node instalado en el perfil de alguien.
function Test-MachineWideNode([string]$NodePath) {
  $machineDirs = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
  return @($machineDirs | Where-Object {
      $NodePath.StartsWith($_.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Cambia (o agrega) CLAVE=valor en el .env, sin tocar el resto del archivo.
function Set-EnvValue([string]$Path, [string]$Key, [string]$Value) {
  $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8)
  $pattern = "^\s*$([regex]::Escape($Key))\s*="
  $found = $false
  $updated = foreach ($line in $lines) {
    if (-not $found -and $line -match $pattern) { $found = $true; "$Key=$Value" } else { $line }
  }
  if (-not $found) { $updated = @($updated) + "$Key=$Value" }
  # UTF-8 sin BOM, como lo lee el server.
  [IO.File]::WriteAllText($Path, (($updated -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding $false))
}

# Configuración del .env que usan los scripts de instalación, con rutas absolutas.
function Get-AppConfig([string]$EnvFile) {
  if (-not (Test-Path -LiteralPath $EnvFile)) {
    throw "No existe $EnvFile. Corré primero .\scripts\setup.ps1."
  }
  $values = Read-EnvFile $EnvFile
  $baseDir = Split-Path -Parent $EnvFile
  $path = {
    param([string]$Key, [string]$Default)
    $value = if ($values[$Key]) { $values[$Key] } else { $Default }
    if (-not $value) { return $null }
    return Resolve-ConfigPath $value $baseDir
  }
  return [pscustomobject]@{
    EnvFile    = [IO.Path]::GetFullPath($EnvFile)
    NodeEnv    = $values['NODE_ENV']
    HostName   = if ($values['HOST']) { $values['HOST'] } else { '127.0.0.1' }
    Port       = if ($values['PORT']) { [int]$values['PORT'] } else { 3000 }
    StorageDir = & $path 'STORAGE_DIR' './storage'
    DataDir    = & $path 'DATA_DIR' './data'
    LogDir     = & $path 'LOG_DIR' './logs'
    BinDir     = & $path 'BIN_DIR' './bin'
    CertPath   = & $path 'HTTPS_CERT_PATH' $null
    KeyPath    = & $path 'HTTPS_KEY_PATH' $null
  }
}
