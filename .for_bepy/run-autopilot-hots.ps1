param(
  [Parameter(Mandatory=$true)][string]$RepoPath,
  [Parameter(Mandatory=$true)][string]$TaskName,
  [string]$TaskPath  = "\ClaudeAutopilot\",
  [string]$ClaudeExe = "C:\Users\tecno\.local\bin\claude.exe"
)

# One-shot wrapper for the 5PM AFK /autopilot run that builds every Heroes of the
# Storm character. Launched by a Windows Scheduled Task (folder \ClaudeAutopilot\).
# Modeled on cron-run's run-tick.ps1: Interactive logon + Limited run level give
# headless `claude` a working keychain. Invoked WITHOUT -NoProfile so the PS
# profile sets PATH (git/python/etc), WITH -ExecutionPolicy Bypass so this unsigned
# file runs. Self-unregisters at the end so the one-shot task does not linger.

$ErrorActionPreference = "Stop"

$logDir = Join-Path $RepoPath ".for_bepy\autopilot-hots"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$log   = Join-Path $logDir ("run_" + $stamp + ".log")
function Log($m) { Add-Content -Path $log -Value ("[" + (Get-Date -Format "HH:mm:ss") + "] " + $m) -Encoding utf8 }

Add-Content -Path (Join-Path $logDir "heartbeat.log") -Value ("[" + $stamp + "] autopilot-hots start (task=$TaskName)") -Encoding utf8

# The autopilot prompt. Scope is pre-confirmed (all heroes), so /autopilot does not
# need to ask which heroes. Raw-git for the few in-repo bookkeeping commits avoids
# /commit's headless test-suite hang; the real deliverable lives outside the repo.
$prompt = @'
/autopilot Add EVERY Heroes of the Storm hero as a character bundle (scope confirmed by Joe = all ~90 heroes; do NOT ask which heroes). Follow the /character-creator skill in GAME mode for game-slug `heroes-of-the-storm`, building the full roster. Read `.for_bepy/ai_todos/27-heroes-of-the-storm-characters.md` for sourcing notes (archive.org / fan-wiki voice rips, prioritize "pissed"/annoyed lines, Murky = translated murloc subtitles). Output to `%APPDATA%\claude-usage-tauri\characters\heroes-of-the-storm\` with a shared game bundle plus per-hero character.json + icon.png + sound pool. Character data lives OUTSIDE the git repo, so for the few in-repo bookkeeping commits use RAW GIT (not /commit) to avoid the headless test-suite hang. Park any hero whose icon/audio cannot be sourced unattended and log it to COMMENTS_FOR_BEPY.md; keep going on the rest. When the roster is done, delete ai_todo 27.
'@

try {
  Set-Location -Path $RepoPath
  Log "START repo=$RepoPath user=$(whoami)"
  $gitSrc = (Get-Command git -ErrorAction SilentlyContinue).Source
  Log "git on PATH: $gitSrc"
  if (-not $gitSrc) { Log "FATAL: git not on PATH (profile not loaded?). Aborting." ; throw "git missing" }
  if (-not (Test-Path $ClaudeExe)) { Log "FATAL: claude not found at $ClaudeExe" ; throw "claude missing" }

  Log "launching headless claude (/autopilot, bypassPermissions)"
  $out = & $ClaudeExe -p $prompt --permission-mode bypassPermissions --no-session-persistence 2>&1 | Out-String
  Log "claude exit=$LASTEXITCODE"
  Add-Content -Path $log -Value "----- claude output -----" -Encoding utf8
  Add-Content -Path $log -Value $out -Encoding utf8
  Add-Content -Path $log -Value "----- end output -----" -Encoding utf8
}
catch { Log ("WRAPPER ERROR: " + $_.Exception.Message) }
finally {
  # One-shot teardown: remove the task regardless of outcome.
  try {
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false -ErrorAction Stop
    Log "task '$TaskName' unregistered (one-shot done)"
    Add-Content -Path (Join-Path $logDir "heartbeat.log") -Value ("[" + (Get-Date -Format "yyyy-MM-dd_HH-mm-ss") + "] run finished; task removed") -Encoding utf8
  }
  catch { Log ("unregister failed: " + $_.Exception.Message) }
}
