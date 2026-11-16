<#
.SYNOPSIS
  Relevamiento de un equipo candidato a servidor de STI-Catcher. No cambia nada.

.DESCRIPTION
  Junta en un archivo de texto lo que hace falta saber para instalar STI-Catcher
  (docs\DEPLOY.md) en este equipo:

    - Windows: versión, edición, si es Server, idioma, actualizaciones.
    - Hardware: CPU, RAM, discos y espacio libre, GPU (NVENC / Quick Sync).
    - Red: IPs, DHCP o fija, DNS, dominio, perfil de red, firewall, puertos ocupados.
    - Software: Node.js, winget, git, .NET Framework (WinSW), política de ejecución.
    - Seguridad: antivirus, Defender, AppLocker, GPOs aplicadas.
    - Internet: proxy, acceso a GitHub, gyan.dev, npm, YouTube; SMTP de Ferozo.
    - Migración: si llega al servidor viejo (SISTEMAS2-PC).
    - Energía, hora y si ya hay algo de STI-Catcher instalado.

  Es independiente del resto del proyecto: se puede copiar solo este archivo
  al equipo (pendrive) antes de tener el código. No pide ni guarda contraseñas.
  Algunas cosas (GPOs, AppLocker, Defender) se ven mejor como administrador.

  Al final escribe una lista de avisos: lo que hay que resolver antes de instalar.

.PARAMETER OutFile
  Dónde guardar el informe. Por defecto, en el Escritorio:
  sti-relevamiento-<EQUIPO>-<fecha>.txt

.PARAMETER OldServer
  Servidor actual, para probar si se pueden copiar los datos desde acá.

.PARAMETER SmtpHost
  Servidor de correo que usa la app (Ferozo).

.PARAMETER SkipNetworkTests
  No prueba conexiones a internet, al SMTP ni al servidor viejo.

.EXAMPLE
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  .\survey-server.ps1
#>
[CmdletBinding()]
param(
  [string]$OutFile,
  [string]$OldServer = '192.168.3.115',
  [string]$SmtpHost = 'c1831749.ferozo.com',
  [switch]$SkipNetworkTests
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

if (-not $OutFile) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if (-not $desktop) { $desktop = (Get-Location).Path }
  $OutFile = Join-Path $desktop ("sti-relevamiento-{0}-{1}.txt" -f $env:COMPUTERNAME, (Get-Date -Format 'yyyyMMdd-HHmm'))
}

$report = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

function Add-Section([string]$Title) {
  $report.Add('')
  $report.Add("== $Title " + ('=' * [Math]::Max(3, 70 - $Title.Length)))
  Write-Host "==> $Title" -ForegroundColor Cyan
}
function Add-Line([string]$Label, $Value) {
  $report.Add(("  {0,-30} {1}" -f $Label, $Value))
}
function Add-Text([string]$Text) {
  foreach ($line in ($Text -split "`r?`n")) { $report.Add("  $line") }
}
function Add-Warning([string]$Text) { $warnings.Add($Text) }

# Corre un bloque y, si falla, deja constancia en el informe en vez de cortar.
function Invoke-Safe([string]$What, [scriptblock]$Block) {
  try { & $Block }
  catch { Add-Line $What "(no se pudo leer: $($_.Exception.Message))" }
}

function Format-GB($Bytes) {
  if ($null -eq $Bytes) { return '?' }
  return ('{0:N1} GB' -f ($Bytes / 1GB))
}

# Ejecuta un .exe y devuelve su salida como texto (sin cortar por stderr).
function Get-NativeOutput([string]$File, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { return ((& $File @Arguments 2>&1 | ForEach-Object { "$_" }) -join "`n").Trim() }
  finally { $ErrorActionPreference = $previous }
}

# Conexión TCP directa (sin proxy), con tiempo límite.
function Test-Tcp([string]$HostName, [int]$Port, [int]$TimeoutMs = 4000) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync($HostName, $Port)
    if (-not $task.Wait($TimeoutMs)) { return 'no responde (tiempo agotado)' }
    if ($client.Connected) { return 'OK' }
    return 'falló'
  }
  catch {
    $inner = $_.Exception
    while ($inner.InnerException) { $inner = $inner.InnerException }
    return "falló: $($inner.Message)"
  }
  finally { $client.Dispose() }
}

# HTTPS con la configuración de proxy del sistema (como lo haría setup.ps1).
function Test-Https([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -TimeoutSec 15 -MaximumRedirection 5
    return "OK ($($response.StatusCode))"
  }
  catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    # Algunos sitios no aceptan HEAD pero responden: eso alcanza para saber que hay salida.
    if ($status) { return "responde (HTTP $status)" }
    return "falló: $($_.Exception.Message)"
  }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

$report.Add('Relevamiento de servidor para STI-Catcher')
$report.Add("Equipo: $env:COMPUTERNAME    Fecha: $(Get-Date -Format 'yyyy-MM-dd HH:mm')    Usuario: $env:USERDOMAIN\$env:USERNAME    Administrador: $(if ($isAdmin) { 'sí' } else { 'no' })")
$report.Add('Este script solo lee: no instaló ni cambió nada.')
if (-not $isAdmin) {
  Add-Warning 'Se corrió sin administrador: GPOs, AppLocker y parte de Defender pueden faltar. Si se puede, volvé a correrlo como administrador.'
}

# --- Windows --------------------------------------------------------------------
Add-Section 'Windows'
$os = $null
Invoke-Safe 'Sistema operativo' {
  $script:os = Get-CimInstance Win32_OperatingSystem
  $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  $productTypes = @{ 1 = 'estación de trabajo'; 2 = 'controlador de dominio'; 3 = 'servidor' }
  Add-Line 'Nombre' $os.Caption
  Add-Line 'Edición (EditionID)' $cv.EditionID
  Add-Line 'Versión' ("{0} (compilación {1}.{2}, {3})" -f $cv.DisplayVersion, $os.BuildNumber, $cv.UBR, $os.OSArchitecture)
  Add-Line 'Tipo' ("{0} — {1}" -f $productTypes[[int]$os.ProductType], $cv.InstallationType)
  Add-Line 'Instalado el' $os.InstallDate.ToString('yyyy-MM-dd')
  Add-Line 'Último arranque' $os.LastBootUpTime.ToString('yyyy-MM-dd HH:mm')
  Add-Line 'Idioma del sistema' ("{0} (interfaz: {1})" -f (Get-Culture).Name, (Get-UICulture).Name)
  if ($os.OSArchitecture -notmatch '64') { Add-Warning 'Windows no es de 64 bits: Node, ffmpeg y Deno necesitan 64 bits.' }
  if ([int]$os.ProductType -ne 1) {
    Add-Warning "Es Windows Server ($($os.Caption)). La app está probada en Windows 10: revisar winget/Node, la cuenta virtual del servicio y el plan de energía."
  }
  if ($cv.InstallationType -eq 'Server Core') {
    Add-Warning 'Es Server Core (sin escritorio): no se puede probar la grabación de pantalla desde el propio servidor y mkcert -install muestra un diálogo.'
  }
  if ([int]$os.ProductType -eq 2) { Add-Warning 'Es un controlador de dominio: no conviene instalar aplicaciones ahí (cuentas virtuales y permisos se comportan distinto).' }
}
Invoke-Safe 'Actualizaciones' {
  $last = Get-HotFix | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 1
  if ($last) {
    Add-Line 'Última actualización' ("{0} ({1})" -f $last.InstalledOn.ToString('yyyy-MM-dd'), $last.HotFixID)
    if ($last.InstalledOn -lt (Get-Date).AddDays(-90)) { Add-Warning "La última actualización de Windows es del $($last.InstalledOn.ToString('yyyy-MM-dd')): hace más de 3 meses." }
  }
}
Invoke-Safe 'PowerShell' { Add-Line 'PowerShell' $PSVersionTable.PSVersion.ToString() }
Invoke-Safe '.NET Framework' {
  $release = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue).Release
  Add-Line '.NET Framework 4 (Release)' $(if ($release) { $release } else { 'no instalado' })
  # WinSW.NET461 necesita .NET Framework 4.6.1 o superior (Release 394254).
  if (-not $release -or $release -lt 394254) { Add-Warning 'Falta .NET Framework 4.6.1 o superior: WinSW (el servicio) no arranca sin él.' }
}

# --- Hardware -------------------------------------------------------------------
Add-Section 'Hardware'
Invoke-Safe 'Equipo' {
  $cs = Get-CimInstance Win32_ComputerSystem
  Add-Line 'Fabricante / modelo' ("{0} {1}" -f $cs.Manufacturer, $cs.Model)
  Add-Line 'RAM' (Format-GB $cs.TotalPhysicalMemory)
  if ($os) { Add-Line 'RAM libre ahora' (Format-GB ($os.FreePhysicalMemory * 1KB)) }
  if ($cs.Model -match 'Virtual|VMware|KVM|HVM|Hyper-V') { Add-Line 'Máquina virtual' 'probablemente sí (sin GPU física salvo que se la asignen)' }
  if ($cs.TotalPhysicalMemory -lt 7GB) { Add-Warning "Tiene $(Format-GB $cs.TotalPhysicalMemory) de RAM: con descargas, conversiones y compresión en paralelo conviene 8 GB o más." }
}
Invoke-Safe 'CPU' {
  foreach ($cpu in @(Get-CimInstance Win32_Processor)) {
    Add-Line 'CPU' ("{0} — {1} núcleos, {2} hilos" -f $cpu.Name.Trim(), $cpu.NumberOfCores, $cpu.NumberOfLogicalProcessors)
  }
}
Invoke-Safe 'Batería' {
  if (@(Get-CimInstance Win32_Battery).Count -gt 0) {
    Add-Line 'Batería' 'sí (es una notebook)'
    Add-Warning 'Tiene batería: es una notebook. Como servidor, que quede siempre enchufada y con la tapa cerrada sin suspender.'
  }
}

# --- GPU ------------------------------------------------------------------------
Add-Section 'GPU (para la sección Compresión)'
Invoke-Safe 'Placas de video' {
  $gpus = @(Get-CimInstance Win32_VideoController)
  foreach ($gpu in $gpus) {
    Add-Line 'Placa' ("{0} — driver {1} ({2})" -f $gpu.Name, $gpu.DriverVersion, $(if ($gpu.DriverDate) { $gpu.DriverDate.ToString('yyyy-MM-dd') } else { '?' }))
  }
  $names = ($gpus | ForEach-Object { $_.Name }) -join ' | '
  if ($names -match 'NVIDIA') { Add-Line 'Aceleración' 'NVIDIA: probablemente NVENC (depende del modelo y del driver)' }
  elseif ($names -match 'Intel') { Add-Line 'Aceleración' 'Intel: probablemente Quick Sync (QSV)' }
  elseif ($names -match 'AMD|Radeon') { Add-Line 'Aceleración' 'AMD: AMF (la app hoy no lo usa)' }
  else { Add-Line 'Aceleración' 'ninguna detectada: la compresión va por CPU' }
}
$nvidiaSmi = @(
  (Get-Command nvidia-smi -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
  "$env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe",
  "$env:SystemRoot\System32\nvidia-smi.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if ($nvidiaSmi) {
  Invoke-Safe 'nvidia-smi' {
    Add-Line 'nvidia-smi' (Get-NativeOutput $nvidiaSmi @('--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'))
  }
}

# --- Discos ---------------------------------------------------------------------
Add-Section 'Discos'
Invoke-Safe 'Volúmenes' {
  foreach ($disk in @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3')) {
    Add-Line ("Unidad {0} ({1})" -f $disk.DeviceID, $disk.VolumeName) ("{0}, {1} libres de {2}" -f $disk.FileSystem, (Format-GB $disk.FreeSpace), (Format-GB $disk.Size))
  }
  $data = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Where-Object { $_.DeviceID -ne $env:SystemDrive })
  if ($data.Count -eq 0) { Add-Warning 'Hay un solo disco: storage (videos) y data van a compartir espacio con Windows. Conviene un disco de datos aparte.' }
  $best = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3') | Sort-Object FreeSpace -Descending | Select-Object -First 1
  if ($best -and $best.FreeSpace -lt 100GB) { Add-Warning "El disco con más espacio ($($best.DeviceID)) tiene $(Format-GB $best.FreeSpace) libres: poco para videos." }
}
Invoke-Safe 'Discos físicos' {
  foreach ($pd in @(Get-PhysicalDisk)) {
    Add-Line 'Disco físico' ("{0} — {1}, {2}, {3}" -f $pd.FriendlyName, $pd.MediaType, $pd.BusType, (Format-GB $pd.Size))
  }
}

# --- Red ------------------------------------------------------------------------
Add-Section 'Red'
Invoke-Safe 'Dominio' {
  $cs = Get-CimInstance Win32_ComputerSystem
  if ($cs.PartOfDomain) { Add-Line 'Dominio' $cs.Domain } else { Add-Line 'Grupo de trabajo' $cs.Workgroup }
  try { Add-Line 'Nombre completo (FQDN)' ([Net.Dns]::GetHostEntry('').HostName) } catch { Add-Line 'Nombre completo (FQDN)' '(sin nombre DNS)' }
}
Invoke-Safe 'Adaptadores' {
  $configs = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True')
  foreach ($cfg in $configs) {
    $ipv4 = @($cfg.IPAddress | Where-Object { $_ -match '^\d+\.' })
    Add-Line 'Adaptador' $cfg.Description
    Add-Line '  IPv4' (($ipv4 -join ', ') + $(if ($cfg.DHCPEnabled) { '  (DHCP)' } else { '  (fija)' }))
    Add-Line '  Puerta de enlace' (@($cfg.DefaultIPGateway) -join ', ')
    Add-Line '  DNS' (@($cfg.DNSServerSearchOrder) -join ', ')
    Add-Line '  Sufijo DNS' $cfg.DNSDomain
    if ($cfg.DHCPEnabled -and $cfg.DefaultIPGateway) {
      Add-Warning "El adaptador '$($cfg.Description)' toma la IP por DHCP ($($ipv4 -join ', ')): hace falta IP fija o una reserva en el DHCP (va en el certificado). Si ya hay reserva, ignorá este aviso."
    }
  }
}
Invoke-Safe 'Perfil de red' {
  foreach ($netProfile in @(Get-NetConnectionProfile)) {
    Add-Line 'Perfil de red' ("{0} ({1}): {2}" -f $netProfile.Name, $netProfile.InterfaceAlias, $netProfile.NetworkCategory)
    if ($netProfile.NetworkCategory -eq 'Public') { Add-Warning "La red '$($netProfile.Name)' es Pública: la regla de firewall de la app no aplica ahí." }
  }
}
Invoke-Safe 'Firewall' {
  foreach ($fw in @(Get-NetFirewallProfile)) {
    Add-Line "Firewall $($fw.Name)" ("{0}, entrada por defecto: {1}" -f $(if ($fw.Enabled) { 'activo' } else { 'apagado' }), $fw.DefaultInboundAction)
  }
}
Invoke-Safe 'Puertos' {
  foreach ($port in 80, 443, 3000, 8443) {
    $listen = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($listen.Count -eq 0) { Add-Line "Puerto $port" 'libre'; continue }
    $owners = $listen | ForEach-Object {
      $pid_ = $_.OwningProcess
      $proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
      if ($pid_ -eq 4) { 'System (http.sys: IIS u otro servicio web)' } elseif ($proc) { "$($proc.ProcessName) (PID $pid_)" } else { "PID $pid_" }
    } | Select-Object -Unique
    Add-Line "Puerto $port" ("ocupado por " + ($owners -join ', '))
    if ($port -eq 443) { Add-Warning 'El puerto 443 ya está ocupado: la app va a necesitar otro (por ejemplo 8443), y entonces el puerto va en la dirección.' }
  }
  $iis = Get-Service -Name W3SVC -ErrorAction SilentlyContinue
  Add-Line 'IIS (W3SVC)' $(if ($iis) { $iis.Status } else { 'no instalado' })
}
Invoke-Safe 'Escritorio remoto' {
  $deny = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server').fDenyTSConnections
  Add-Line 'Escritorio remoto' $(if ($deny -eq 0) { 'habilitado' } else { 'deshabilitado' })
}

# --- Software -------------------------------------------------------------------
Add-Section 'Software'
Invoke-Safe 'Node.js' {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    $version = Get-NativeOutput $node.Source @('-v')
    $machineWide = $node.Source.StartsWith($env:ProgramFiles + '\', [StringComparison]::OrdinalIgnoreCase)
    Add-Line 'Node.js' ("{0} en {1} ({2})" -f $version, $node.Source, $(if ($machineWide) { 'para todos los usuarios' } else { 'solo este usuario' }))
    if (-not $machineWide) { Add-Warning 'Node.js está instalado solo para un usuario: el servicio necesita uno para todos (C:\Program Files\nodejs).' }
    if ([int]($version.TrimStart('v').Split('.')[0]) -lt 24) { Add-Warning "Node.js $version es viejo: hace falta 24 o superior." }
  }
  else { Add-Line 'Node.js' 'no instalado' }
}
foreach ($tool in 'winget', 'git', 'npm') {
  Invoke-Safe $tool {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    Add-Line $tool $(if ($cmd) { "$($cmd.Source)  $(Get-NativeOutput $cmd.Source @('--version') | Select-Object -First 1)" } else { 'no instalado' })
  }
}
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Add-Warning 'No hay winget: Node.js se instala con el instalador MSI de nodejs.org (opción «para todos los usuarios»).'
}
Invoke-Safe 'Política de ejecución' {
  $policies = Get-ExecutionPolicy -List | ForEach-Object { "$($_.Scope)=$($_.ExecutionPolicy)" }
  Add-Line 'Política de ejecución' ($policies -join ', ')
  $forced = Get-ExecutionPolicy -List | Where-Object { $_.Scope -in 'MachinePolicy', 'UserPolicy' -and $_.ExecutionPolicy -ne 'Undefined' }
  foreach ($p in $forced) {
    if ($p.ExecutionPolicy -in 'Restricted', 'AllSigned') {
      Add-Warning "Una GPO fija la política de ejecución ($($p.Scope)=$($p.ExecutionPolicy)): Set-ExecutionPolicy -Scope Process no alcanza y los scripts de instalación no van a correr. Hay que pedir una excepción."
    }
  }
}
Invoke-Safe 'STI-Catcher' {
  $svc = Get-Service -Name sti-catcher -ErrorAction SilentlyContinue
  Add-Line 'Servicio sti-catcher' $(if ($svc) { "existe ($($svc.Status))" } else { 'no existe' })
  foreach ($dir in 'C:\STI-Catcher', 'D:\STI-Catcher', 'E:\STI-Catcher') {
    if (Test-Path -LiteralPath $dir) { Add-Line 'Carpeta' "$dir ya existe" }
  }
}

# --- Seguridad ------------------------------------------------------------------
Add-Section 'Seguridad'
Invoke-Safe 'Antivirus' {
  $av = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue)
  if ($av.Count -gt 0) { Add-Line 'Antivirus' (($av | ForEach-Object { $_.displayName }) -join ', ') }
  else { Add-Line 'Antivirus' '(Centro de seguridad no disponible: normal en Windows Server)' }
}
Invoke-Safe 'Defender' {
  $mp = Get-MpComputerStatus
  Add-Line 'Defender' ("modo {0}, tiempo real: {1}" -f $mp.AMRunningMode, $mp.RealTimeProtectionEnabled)
  try {
    $pref = Get-MpPreference
    Add-Line 'Defender: carpetas excluidas' $(if ($pref.ExclusionPath) { $pref.ExclusionPath -join ', ' } else { 'ninguna (o sin permiso para verlas)' })
    if ($pref.EnableControlledFolderAccess -eq 1) { Add-Warning 'Defender tiene «Acceso controlado a carpetas» activo: puede bloquear que el servicio escriba videos.' }
  }
  catch { Write-Verbose $_ }
}
Invoke-Safe 'AppLocker' {
  $policy = Get-AppLockerPolicy -Effective -Xml
  $rules = ([xml]$policy).AppLockerPolicy.RuleCollection | Where-Object { $_.EnforcementMode -ne 'NotConfigured' -and $_.HasChildNodes }
  if ($rules) {
    Add-Line 'AppLocker' ("reglas activas: " + (($rules | ForEach-Object { "$($_.Type) ($($_.EnforcementMode))" }) -join ', '))
    Add-Warning 'AppLocker tiene reglas: puede bloquear yt-dlp, ffmpeg, deno o WinSW (son .exe descargados). Pedir excepción para la carpeta de la app.'
  }
  else { Add-Line 'AppLocker' 'sin reglas' }
}
Invoke-Safe 'Control de aplicaciones (WDAC)' {
  $dg = Get-CimInstance -Namespace root/Microsoft/Windows/DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction SilentlyContinue
  if ($dg) {
    $modes = @{ 0 = 'apagado'; 1 = 'auditoría'; 2 = 'obligatorio' }
    Add-Line 'WDAC (código de usuario)' $modes[[int]$dg.UsermodeCodeIntegrityPolicyEnforcementStatus]
    if ([int]$dg.UsermodeCodeIntegrityPolicyEnforcementStatus -eq 2) { Add-Warning 'WDAC está en modo obligatorio: los .exe descargados (yt-dlp, ffmpeg, deno, WinSW) pueden quedar bloqueados.' }
  }
}
if ($isAdmin) {
  Invoke-Safe 'GPOs del equipo' {
    $gp = Get-NativeOutput 'gpresult.exe' @('/r', '/scope', 'computer')
    Add-Line 'GPOs del equipo' '(salida de gpresult /r /scope computer)'
    Add-Text $gp
  }
}

# --- Internet -------------------------------------------------------------------
Add-Section 'Internet y proxy'
Invoke-Safe 'Proxy' {
  Add-Line 'Proxy WinHTTP (equipo)' ((Get-NativeOutput 'netsh.exe' @('winhttp', 'show', 'proxy')) -replace '\s+', ' ')
  $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
  Add-Line 'Proxy de este usuario' ("activo: {0}, servidor: {1}, script: {2}" -f [bool]$ie.ProxyEnable, $ie.ProxyServer, $ie.AutoConfigURL)
  foreach ($name in 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY') {
    $value = [Environment]::GetEnvironmentVariable($name, 'Machine')
    if ($value) { Add-Line "Variable $name (equipo)" $value }
  }
  if ($ie.ProxyEnable -or $ie.AutoConfigURL) {
    Add-Warning 'Hay un proxy configurado: el servicio corre con otra cuenta y no lo hereda. yt-dlp y el mail necesitarían salir directo o configurar el proxy en la app (hoy no se puede).'
  }
}
if ($SkipNetworkTests) {
  Add-Line 'Pruebas de conexión' 'salteadas (-SkipNetworkTests)'
}
else {
  # Directo (TCP, sin proxy) = como va a salir el servicio. HTTPS = como sale setup.ps1.
  $sites = [ordered]@{
    'github.com'                        = 'binarios: yt-dlp, Deno, WinSW, mkcert'
    'objects.githubusercontent.com'     = 'descargas de GitHub'
    'release-assets.githubusercontent.com' = 'descargas de GitHub'
    'www.gyan.dev'                      = 'ffmpeg'
    'registry.npmjs.org'                = 'npm ci'
    'nodejs.org'                        = 'instalador de Node'
    'www.youtube.com'                   = 'descargas de la app'
  }
  foreach ($site in $sites.Keys) {
    $direct = Test-Tcp $site 443
    $https = Test-Https "https://$site/"
    Add-Line $site ("directo: {0}; HTTPS: {1}  [{2}]" -f $direct, $https, $sites[$site])
    if ($direct -ne 'OK' -and $site -in 'github.com', 'www.youtube.com') {
      Add-Warning "No hay salida directa a $site`:443: el servicio no va a poder descargar."
    }
  }
  Add-Section 'Correo (SMTP)'
  foreach ($port in 465, 587) {
    $result = Test-Tcp $SmtpHost $port
    Add-Line "$SmtpHost`:$port" $result
  }
  if ((Test-Tcp $SmtpHost 465) -ne 'OK') { Add-Warning "No se llega a $SmtpHost`:465: los avisos por mail no van a salir (revisar firewall de salida)." }

  Add-Section "Servidor viejo ($OldServer)"
  foreach ($port in 3000, 445, 3389) {
    $label = @{ 3000 = 'la app'; 445 = 'carpetas compartidas, para copiar datos'; 3389 = 'escritorio remoto' }[$port]
    Add-Line "Puerto $port ($label)" (Test-Tcp $OldServer $port)
  }
}

# --- Energía y hora -------------------------------------------------------------
Add-Section 'Energía y hora'
Invoke-Safe 'Plan de energía' {
  Add-Line 'Plan activo' ((Get-NativeOutput 'powercfg.exe' @('/getactivescheme')) -replace '^.*?:\s*', '')
  $values = @([regex]::Matches((Get-NativeOutput 'powercfg.exe' @('/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE')), '0x[0-9a-fA-F]+') | ForEach-Object { $_.Value })
  if ($values.Count -ge 2) {
    $minutes = [Convert]::ToInt32($values[-2], 16) / 60
    Add-Line 'Suspender (enchufado)' $(if ($minutes -eq 0) { 'nunca' } else { "a los $minutes min" })
    if ($minutes -ne 0) { Add-Line '' 'install-service.ps1 -DisableSleep lo corrige' }
  }
}
Invoke-Safe 'Hora' {
  Add-Line 'Zona horaria' (Get-TimeZone).DisplayName
  Add-Line 'Fuente de hora' (Get-NativeOutput 'w32tm.exe' @('/query', '/source'))
}

# --- Resumen --------------------------------------------------------------------
$report.Add('')
$report.Add('== Avisos ' + ('=' * 64))
if ($warnings.Count -eq 0) { $report.Add('  Ninguno.') }
foreach ($w in $warnings) { $report.Add("  - $w") }

$report.Add('')
$report.Add('== Para completar a mano ' + ('=' * 48))
foreach ($q in @(
    'Nombre con el que entran los compañeros (alias DNS, p. ej. sti.empresa.local, o el nombre del equipo):',
    'Carpeta para storage (videos) y data (base):',
    '¿Se pasa el historial desde SISTEMAS2-PC? (sí/no):',
    '¿Quién administra este equipo y hace los backups?:',
    'Fecha prevista para apagar el servicio en SISTEMAS2-PC:'
  )) { $report.Add("  $q") }

[IO.File]::WriteAllLines($OutFile, $report, (New-Object Text.UTF8Encoding $true))
Write-Host ''
Write-Host "Informe guardado en: $OutFile" -ForegroundColor Green
Write-Host "Avisos: $($warnings.Count). Revisalo y pasalo a quien prepara la instalación (no tiene contraseñas)."
