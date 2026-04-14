param([string]$Endpoint = "refresh")

$ErrorActionPreference = "SilentlyContinue"

$body = [Console]::In.ReadToEnd()
try { $obj = $body | ConvertFrom-Json } catch { $obj = [PSCustomObject]@{} }
if ($null -eq $obj) { $obj = [PSCustomObject]@{} }

$chain = @()
$p = $PID
for ($i = 0; $i -lt 10; $i++) {
  if (-not $p -or $p -eq 0) { break }
  $pr = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue
  if (-not $pr) { break }
  $chain += [int]$pr.ProcessId
  $p = [int]$pr.ParentProcessId
}

$origin = @{
  termProgram = $env:TERM_PROGRAM
  vscodePipe  = $env:VSCODE_IPC_HOOK_CLI
  wtSession   = $env:WT_SESSION
  ppidChain   = $chain
}

$obj | Add-Member -NotePropertyName origin -NotePropertyValue $origin -Force

$json = $obj | ConvertTo-Json -Compress -Depth 8
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:27182/$Endpoint" -Method Post -ContentType "application/json" -Body $json -TimeoutSec 2 | Out-Null
} catch {}
