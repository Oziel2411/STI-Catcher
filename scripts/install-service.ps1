<#
.SYNOPSIS
  Instala (o reinstala) STI-Catcher como servicio de Windows. Requiere administrador.

.DESCRIPTION
  1. Verifica la configuración: .env de producción con HTTPS, build hecho, Node.js
     para todos los usuarios.
  2. Descarga WinSW 2.12.0 (SHA-256 fijado) a <app>\service\sti-catcher.exe y
     genera sti-catcher.xml con las rutas de este equipo.
  3. Instala el servicio con la cuenta virtual "NT SERVICE\sti-catcher" (sin
     contraseña y exclusiva de este servicio; no LocalSystem). Inicio automático
     (retrasado) y reinicio si se cae.
  4. Permisos de esa cuenta: lectura en la app, BIN_DIR y Node; modificación
     solo en STORAGE_DIR, DATA_DIR y LOG_DIR; la clave del certificado la leen
     solo esa cuenta, SYSTEM y Administradores.
  5. Regla de entrada en el Firewall de Windows para el puerto (perfiles
     Dominio y Privado).
  6. Inicia el servicio y prueba https://localhost:<PORT>/api/health.

  Si el servicio ya existe, lo detiene y lo vuelve a instalar (sirve para
  actualizar). No toca los datos.

.PARAMETER DisableSleep
  Además, configura el plan de energía para que el equipo no se suspenda ni
  hiberne con corriente alterna. El servidor no puede suspenderse.

.PARAMETER DryRun
  No instala nada: verifica, descarga WinSW, genera el XML y muestra lo que haría.
  No requiere administrador.

.EXAMPLE
  .\scripts\install-service.ps1 -DisableSleep
.EXAMPLE
  .\scripts\install-service.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [switch]$DisableSleep,
  [switch]$DryRun
)

. "$PSScriptRoot\common.ps1"

$ServiceId = 'sti-catcher'
$ServiceAccount = "NT SERVICE\$ServiceId"
$FirewallRuleName = 'STI-Catcher-HTTPS'
$WinswUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe'
$WinswSha256 = 'B5066B7BBDFBA1293E5D15CDA3CAAEA88FBEAB35BD5B38C41C913D492AADFC4F'
# SIDs en vez de nombres: en un Windows en español el grupo se llama "Administradores".
$SidAdministrators = '*S-1-5-32-544'
$SidSystem = '*S-1-5-18'

function Invoke-Action([string]$Description, [scriptblock]$Action) {
  if ($DryRun) { Write-Host "    [simulación] $Description" -ForegroundColor Yellow; return }
  & $Action
  Write-Ok $Description
}

function Invoke-Native([string]$File, [string[]]$Arguments) {
  # En PowerShell 5.1, con 'Stop', cualquier línea de stderr de un .exe se vuelve
  # una excepción aunque termine bien: se decide solo por el código de salida.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $File @Arguments 2>&1 | ForEach-Object { "$_" }
  }
  finally {
    $ErrorActionPreference = $previous
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Falló: $File $($Arguments -join ' ')`n$($output -join "`n")"
  }
  return $output
}

function Grant-Access([string]$Path, [string]$Rights) {
  Invoke-Action "$ServiceAccount — $Rights en $Path" {
    Invoke-Native 'icacls.exe' @($Path, '/grant', "${ServiceAccount}:(OI)(CI)$Rights", '/Q') | Out-Null
  }
}

function Test-Inside([string]$Child, [string]$Parent) {
  return $Child.StartsWith($Parent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
  $Child.TrimEnd('\') -ieq $Parent.TrimEnd('\')
}

if (-not $DryRun -and -not (Test-Administrator)) {
  throw 'Este script instala un servicio: abrí PowerShell como administrador (o probá con -DryRun).'
}

# --- 1. Verificaciones ----------------------------------------------------------
Write-Step 'Verificando la instalación'
$config = Get-AppConfig (Get-EnvFilePath)
$appDir = [IO.Path]::GetFullPath($RepoRoot)
$problems = @()

if ($config.NodeEnv -ne 'production') { $problems += 'En el .env falta NODE_ENV=production.' }
if (-not $config.CertPath -or -not $config.KeyPath) {
  $problems += 'Falta HTTPS en el .env: corré .\scripts\new-certificate.ps1.'
}
else {
  foreach ($file in @($config.CertPath, $config.KeyPath)) {
    if (-not (Test-Path -LiteralPath $file)) { $problems += "No existe $file." }
  }
}
foreach ($file in @('apps\server\dist\main.js', 'apps\web\dist\index.html')) {
  if (-not (Test-Path -LiteralPath (Join-Path $appDir $file))) {
    $problems += "Falta $file`: corré npm ci y npm run build."
  }
}
foreach ($tool in @('yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe', 'deno.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $config.BinDir $tool))) {
    $problems += "Falta $tool en $($config.BinDir): corré .\scripts\setup.ps1."
  }
}
# La cuenta del servicio no puede entrar al perfil de un usuario.
$profilesDir = Split-Path -Parent $env:USERPROFILE
foreach ($dir in @($appDir, $config.StorageDir, $config.DataDir, $config.LogDir, $config.BinDir)) {
  if (Test-Inside $dir $profilesDir) {
    $problems += "$dir está dentro de un perfil de usuario: el servicio no tendría acceso. Usá por ejemplo C:\STI-Catcher."
  }
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  $problems += 'No se encontró Node.js: winget install --id OpenJS.NodeJS.LTS --scope machine'
}
elseif (-not (Test-MachineWideNode $nodeCommand.Source)) {
  $problems += "Node.js está instalado solo para un usuario ($($nodeCommand.Source)). El servicio necesita uno para todos: winget install --id OpenJS.NodeJS.LTS --scope machine"
}

if ($problems.Count -gt 0) {
  $message = "No se puede instalar todavía:`n" + (($problems | ForEach-Object { "  - $_" }) -join "`n")
  if ($DryRun) { Write-Warning $message } else { throw $message }
}
else {
  Write-Ok "Configuración: $($config.EnvFile)"
}
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { 'node.exe' }
if ($config.HostName -in @('127.0.0.1', 'localhost', '::1')) {
  Write-Warning "HOST=$($config.HostName): solo se va a poder entrar desde este equipo. Para la red: HOST=0.0.0.0."
}

# --- 2. WinSW y su configuración ---------------------------------------------------
Write-Step 'WinSW'
$serviceDir = Join-Path $appDir 'service'
New-Item -ItemType Directory -Force -Path $serviceDir | Out-Null
$winsw = Join-Path $serviceDir "$ServiceId.exe"
$xmlPath = Join-Path $serviceDir "$ServiceId.xml"

$existing = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
if ($existing) {
  # El .exe en uso no se puede reemplazar: primero se desinstala el servicio.
  Invoke-Action "Detener y desinstalar el servicio existente ($($existing.Status))" {
    if ($existing.Status -ne 'Stopped') { Stop-Service -Name $ServiceId -Force }
    Invoke-Native $winsw @('uninstall') | Out-Null
    Start-Sleep -Seconds 2
  }
}

if (Test-FileHash $winsw $WinswSha256) {
  Write-Skip "Ya está: $winsw"
}
else {
  Invoke-PinnedDownload $WinswUrl $WinswSha256 $winsw
  Write-Ok $winsw
}

$x = { param([string]$Value) [Security.SecurityElement]::Escape($Value) }
$serviceLogDir = Join-Path $config.LogDir 'service'
$xml = @"
<?xml version="1.0" encoding="utf-8"?>
<!-- Generado por scripts\install-service.ps1. No editar: se regenera al reinstalar. -->
<service>
  <id>$ServiceId</id>
  <name>STI-Catcher</name>
  <description>Descargas, grabación de pantalla y conversión para la red interna.</description>
  <executable>$(& $x $nodePath)</executable>
  <arguments>"$(& $x (Join-Path $appDir 'apps\server\dist\main.js'))"</arguments>
  <workingdirectory>$(& $x $appDir)</workingdirectory>
  <env name="STI_ENV_FILE" value="$(& $x $config.EnvFile)" />
  <serviceaccount>
    <domain>NT SERVICE</domain>
    <user>$ServiceId</user>
  </serviceaccount>
  <startmode>Automatic</startmode>
  <delayedAutoStart/>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <onfailure action="restart" delay="2 min"/>
  <resetfailure>1 hour</resetfailure>
  <!-- Ctrl+C primero a Node: corta los trabajos en curso y mata a ffmpeg/yt-dlp él mismo. -->
  <stopparentprocessfirst>true</stopparentprocessfirst>
  <stoptimeout>30 sec</stoptimeout>
  <logpath>$(& $x $serviceLogDir)</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
</service>
"@
[IO.File]::WriteAllText($xmlPath, $xml, (New-Object Text.UTF8Encoding $false))
# Valida que WinSW pueda leer el XML (no requiere administrador).
$status = (Invoke-Native $winsw @('status')) -join ' '
Write-Ok "Configuración del servicio: $xmlPath (estado: $status)"

# --- 3. Servicio ------------------------------------------------------------------
Write-Step "Servicio $ServiceId"
foreach ($dir in @($config.StorageDir, $config.DataDir, $config.LogDir, $serviceLogDir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}
Invoke-Action "Instalar con la cuenta $ServiceAccount" {
  try {
    Invoke-Native $winsw @('install') | Out-Null
  }
  catch {
    # Plan B (D-051): instalar con LocalService y pasar a la cuenta virtual con sc.exe.
    Write-Warning "WinSW no pudo instalar con la cuenta virtual: $_. Probando con sc.exe."
    $fallback = $xml -replace '(?s)<serviceaccount>.*?</serviceaccount>',
    "<serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>"
    [IO.File]::WriteAllText($xmlPath, $fallback, (New-Object Text.UTF8Encoding $false))
    Invoke-Native $winsw @('install') | Out-Null
    # Las cuentas virtuales no tienen contraseña: no se pasa password=.
    Invoke-Native 'sc.exe' @('config', $ServiceId, 'obj=', $ServiceAccount) | Out-Null
  }
  $account = (Get-CimInstance Win32_Service -Filter "Name='$ServiceId'").StartName
  if ($account -ne $ServiceAccount) { throw "El servicio quedó con la cuenta '$account' en vez de $ServiceAccount." }
}

# --- 4. Permisos ------------------------------------------------------------------
# Recién ahora existe la cuenta virtual.
Write-Step 'Permisos'
Grant-Access $appDir 'RX'
if (-not (Test-Inside $config.BinDir $appDir)) { Grant-Access $config.BinDir 'RX' }
Grant-Access (Split-Path -Parent $nodePath) 'RX'
foreach ($dir in @($config.StorageDir, $config.DataDir, $config.LogDir)) { Grant-Access $dir 'M' }
if (-not (Test-Inside $config.EnvFile $appDir)) {
  Invoke-Action "$ServiceAccount — lectura de $($config.EnvFile)" {
    Invoke-Native 'icacls.exe' @($config.EnvFile, '/grant', "${ServiceAccount}:R", '/Q') | Out-Null
  }
}
if ($config.KeyPath) {
  Invoke-Action "Clave privada legible solo por $ServiceAccount, SYSTEM y Administradores" {
    Invoke-Native 'icacls.exe' @($config.KeyPath, '/inheritance:r', '/grant:r',
      "${SidAdministrators}:F", "${SidSystem}:F", "${ServiceAccount}:R", '/Q') | Out-Null
  }
}

# --- 5. Firewall ------------------------------------------------------------------
Write-Step 'Firewall'
Invoke-Action "Regla de entrada TCP $($config.Port) (perfiles Dominio y Privado)" {
  Get-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -Name $FirewallRuleName -DisplayName "STI-Catcher (TCP $($config.Port))" `
    -Description 'Acceso de la red interna a STI-Catcher. Creada por install-service.ps1.' `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort $config.Port `
    -Profile Domain, Private | Out-Null
}
$publicNetworks = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue |
    Where-Object { $_.NetworkCategory -eq 'Public' })
foreach ($network in $publicNetworks) {
  Write-Warning "La red '$($network.Name)' ($($network.InterfaceAlias)) es Pública: la regla no aplica ahí. Cambiala a Privada (Configuración > Red e Internet > Propiedades)."
}

# --- 6. Energía -------------------------------------------------------------------
Write-Step 'Suspensión'
if ($DisableSleep) {
  Invoke-Action 'No suspender ni hibernar con corriente alterna' {
    Invoke-Native 'powercfg.exe' @('/change', 'standby-timeout-ac', '0') | Out-Null
    Invoke-Native 'powercfg.exe' @('/change', 'hibernate-timeout-ac', '0') | Out-Null
  }
}
else {
  # Los dos últimos valores hexadecimales son los índices de CA y CC (la salida está traducida).
  $values = @([regex]::Matches(((& powercfg.exe /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE) -join "`n"), '0x[0-9a-fA-F]+') |
      ForEach-Object { $_.Value })
  if ($values.Count -ge 2 -and [Convert]::ToInt32($values[-2], 16) -ne 0) {
    Write-Warning "El equipo se suspende tras $([Convert]::ToInt32($values[-2], 16) / 60) min sin uso. Un servidor no puede suspenderse: volvé a correr con -DisableSleep."
  }
  else {
    Write-Ok 'El equipo no se suspende con corriente alterna.'
  }
}

# --- 7. Inicio y prueba -----------------------------------------------------------
Write-Step 'Iniciando'
Invoke-Action 'Iniciar el servicio' { Start-Service -Name $ServiceId }
if (-not $DryRun) {
  $url = "https://localhost:$($config.Port)/api/health"
  $healthy = $false
  for ($i = 0; $i -lt 20 -and -not $healthy; $i++) {
    Start-Sleep -Seconds 2
    try {
      $healthy = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200
    }
    catch {
      Write-Verbose $_
    }
  }
  if ($healthy) {
    Write-Ok "Responde en $url"
  }
  else {
    Write-Warning "El servicio no responde en $url. Revisá $serviceLogDir (errores al arrancar) y $($config.LogDir)."
  }
}

Write-Host ''
Write-Host ($(if ($DryRun) { 'Simulación terminada: no se instaló nada.' } else { 'Listo.' })) -ForegroundColor Green
