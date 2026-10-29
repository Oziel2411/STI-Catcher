<#
.SYNOPSIS
  Detiene y desinstala el servicio de STI-Catcher y su regla de firewall. Requiere administrador.

.DESCRIPTION
  No borra nada más: STORAGE_DIR, DATA_DIR, LOG_DIR, el .env y los certificados
  quedan como están. Para volver a instalar: .\scripts\install-service.ps1.
#>
[CmdletBinding()]
param()

. "$PSScriptRoot\common.ps1"

$ServiceId = 'sti-catcher'
$FirewallRuleName = 'STI-Catcher-HTTPS'

if (-not (Test-Administrator)) {
  throw 'Abrí PowerShell como administrador para desinstalar el servicio.'
}

Write-Step "Servicio $ServiceId"
$service = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
if ($service) {
  if ($service.Status -ne 'Stopped') {
    Stop-Service -Name $ServiceId -Force
    Write-Ok 'Detenido'
  }
  $winsw = Join-Path $RepoRoot "service\$ServiceId.exe"
  if (Test-Path -LiteralPath $winsw) {
    & $winsw uninstall
  }
  else {
    & sc.exe delete $ServiceId
  }
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo desinstalar el servicio.' }
  Write-Ok 'Desinstalado'
}
else {
  Write-Skip 'No está instalado.'
}

Write-Step 'Firewall'
$rule = Get-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue
if ($rule) {
  $rule | Remove-NetFirewallRule
  Write-Ok "Regla $FirewallRuleName eliminada"
}
else {
  Write-Skip 'No hay regla.'
}
