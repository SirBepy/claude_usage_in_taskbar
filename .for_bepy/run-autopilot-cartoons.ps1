param(
  [Parameter(Mandatory=$true)][string]$RepoPath,
  [Parameter(Mandatory=$true)][string]$TaskName,
  [string]$TaskPath  = "\ClaudeAutopilot\",
  [string]$ClaudeExe = "C:\Users\tecno\.local\bin\claude.exe"
)

# One-shot wrapper for the 7PM AFK /autopilot run that builds the cartoon roster:
# SpongeBob (3) + Family Guy (6) + Simpsons family (5). Staggered 2h after the
# HotS run so the two headless autopilots don't thrash shared rate limits.
# Same launch model as run-autopilot-hots.ps1 (Interactive/Limited principal in
# the scheduled task, profile-loaded PATH, ExecutionPolicy Bypass). Self-removes.

$ErrorActionPreference = "Stop"

$logDir = Join-Path $RepoPath ".for_bepy\autopilot-cartoons"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$log   = Join-Path $logDir ("run_" + $stamp + ".log")
function Log($m) { Add-Content -Path $log -Value ("[" + (Get-Date -Format "HH:mm:ss") + "] " + $m) -Encoding utf8 }

Add-Content -Path (Join-Path $logDir "heartbeat.log") -Value ("[" + $stamp + "] autopilot-cartoons start (task=$TaskName)") -Encoding utf8

# Scope is pre-confirmed and listed explicitly (headless = no chat context).
$prompt = @'
/autopilot Build these cartoon characters as character bundles, scope confirmed by Joe (do NOT ask which characters). Follow the /character-creator skill in GAME mode, one batch per game. Read `.for_bepy/ai_todos/26-spongebob-family-guy-characters.md` for the SpongeBob/Family-Guy sourcing notes (archive.org bulk-zip per franchise, soundboards, discard >5s / trim <=2s). Build exactly:

- game `spongebob` (SpongeBob SquarePants): spongebob, patrick, squidward
- game `family-guy`: stewie, peter, brian, quagmire, cleveland, meg
- game `simpsons` (The Simpsons): homer, marge, bart, lisa, abe (Grandpa / Abraham Simpson)

Output to `%APPDATA%\claude-usage-tauri\characters\<game>\<char>\` with a shared game bundle plus per-char character.json + icon.png + sound pool. Character data lives OUTSIDE the git repo, so for the few in-repo bookkeeping commits use RAW GIT (not /commit) to avoid the headless test-suite hang. Park any character whose icon/audio can't be sourced unattended and log it to COMMENTS_FOR_BEPY.md; keep going on the rest. When all three games are done, delete ai_todo 26.
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
  try {
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false -ErrorAction Stop
    Log "task '$TaskName' unregistered (one-shot done)"
    Add-Content -Path (Join-Path $logDir "heartbeat.log") -Value ("[" + (Get-Date -Format "yyyy-MM-dd_HH-mm-ss") + "] run finished; task removed") -Encoding utf8
  }
  catch { Log ("unregister failed: " + $_.Exception.Message) }
}
