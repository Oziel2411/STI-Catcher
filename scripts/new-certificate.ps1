<#
.SYNOPSIS
  Genera el certificado HTTPS del servidor con mkcert y lo configura en el .env.

.DESCRIPTION
  1. Descarga mkcert 1.4.4 a BIN_DIR (SHA-256 fijado en este script).
  2. Crea la autoridad de certificación (CA) local si no existe y la instala
     como confiable en este equipo (Windows muestra un aviso: aceptarlo).
  3. Genera un certificado para el nombre del equipo, su nombre completo en el
     dominio, sus IPv4 y localhost, en <DATA_DIR>\certs.
  4. Copia el certificado público de la CA a <DATA_DIR>\certs\sti-catcher-ca.crt:
     es el archivo que se instala en las PCs cliente (ver docs\DEPLOY.md).
  5. Escribe HTTPS_CERT_PATH y HTTPS_KEY_PATH en el .env.

  La clave de la CA (rootCA-key.pem) queda en el perfil de quien corre el
  script (mkcert -CAROOT) y nunca sale de este equipo.

  Volver a correrlo con -Force si cambia la IP o el nombre del equipo, o antes
  de que venza el certificado (mkcert los emite por 2 años y 3 meses).

.PARAMETER Names
  Nombres o IPs adicionales para el certificado (p. ej. un alias DNS).

.PARAMETER Force
  Regenera el certificado aunque ya exista.

.PARAMETER SkipCaInstall
  No instala la CA en este equipo (solo para pruebas).

.EXAMPLE
  .\scripts\new-certificate.ps1
.EXAMPLE
  .\scripts\new-certificate.ps1 -Names sti.empresa.local -Force
#>
[CmdletBinding()]
param(
  [string[]]$Names = @(),
  [switch]$Force,
  [switch]$SkipCaInstall
)

. "$PSScriptRoot\common.ps1"

$MkcertUrl = 'https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-windows-amd64.exe'
$MkcertSha256 = 'D2660B50A9ED59EADA480750561C96ABC2ED4C9A38C6A24D93E30E0977631398'

$config = Get-AppConfig (Get-EnvFilePath)

# --- 1. mkcert ----------------------------------------------------------------
Write-Step 'mkcert'
New-Item -ItemType Directory -Force -Path $config.BinDir | Out-Null
$mkcert = Join-Path $config.BinDir 'mkcert.exe'
if (Test-FileHash $mkcert $MkcertSha256) {
  Write-Skip "Ya está: $mkcert"
}
else {
  Invoke-PinnedDownload $MkcertUrl $MkcertSha256 $mkcert
  Write-Ok $mkcert
}

# --- 2. CA local --------------------------------------------------------------
Write-Step 'Autoridad de certificación local'
$caRoot = (& $mkcert -CAROOT).Trim()
if ($SkipCaInstall) {
  Write-Skip 'No se instala la CA en este equipo (-SkipCaInstall).'
}
else {
  # Crea la CA si no existe y la agrega a los certificados raíz confiables del usuario.
  & $mkcert -install
  if ($LASTEXITCODE -ne 0) { throw 'mkcert -install falló.' }
  Write-Ok "CA en $caRoot"
}

# --- 3. Certificado del servidor -----------------------------------------------
Write-Step 'Certificado del servidor'
$certDir = Join-Path $config.DataDir 'certs'
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
$certFile = Join-Path $certDir 'sti-catcher.pem'
$keyFile = Join-Path $certDir 'sti-catcher-key.pem'

$hostNames = @($env:COMPUTERNAME.ToLowerInvariant())
try {
  $fqdn = [Net.Dns]::GetHostEntry('').HostName.ToLowerInvariant()
  if ($fqdn -and $fqdn -ne $hostNames[0]) { $hostNames += $fqdn }
}
catch {
  Write-Verbose "Sin nombre DNS completo: $_"
}
$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress)
$allNames = @($hostNames + $ips + @('localhost', '127.0.0.1') + $Names) |
  Where-Object { $_ } | Select-Object -Unique

if ((Test-Path -LiteralPath $certFile) -and (Test-Path -LiteralPath $keyFile) -and -not $Force) {
  Write-Skip "Ya existe $certFile (usá -Force para regenerarlo)."
}
else {
  & $mkcert -cert-file $certFile -key-file $keyFile @allNames
  if ($LASTEXITCODE -ne 0) { throw 'mkcert no pudo generar el certificado.' }
  Write-Ok "Certificado para: $($allNames -join ', ')"
}

# --- 4. CA para las PCs cliente -------------------------------------------------
$caPublic = Join-Path $caRoot 'rootCA.pem'
$caForClients = Join-Path $certDir 'sti-catcher-ca.crt'
if (Test-Path -LiteralPath $caPublic) {
  Copy-Item -LiteralPath $caPublic -Destination $caForClients -Force
  Write-Ok "CA para instalar en las PCs cliente: $caForClients"
}

# --- 5. .env ------------------------------------------------------------------
Write-Step 'Configuración'
Set-EnvValue $config.EnvFile 'HTTPS_CERT_PATH' $certFile
Set-EnvValue $config.EnvFile 'HTTPS_KEY_PATH' $keyFile
Write-Ok "HTTPS_CERT_PATH y HTTPS_KEY_PATH en $($config.EnvFile)"

Write-Host ''
Write-Host 'Listo. Direcciones válidas para los clientes:' -ForegroundColor Green
foreach ($name in ($allNames | Where-Object { $_ -notin @('localhost', '127.0.0.1') })) {
  Write-Host "  https://${name}:$($config.Port)"
}
if ($config.HostName -in @('127.0.0.1', 'localhost', '::1')) {
  Write-Warning "HOST=$($config.HostName): solo se puede entrar desde este equipo. Para la red, poné HOST=0.0.0.0 en el .env."
}
