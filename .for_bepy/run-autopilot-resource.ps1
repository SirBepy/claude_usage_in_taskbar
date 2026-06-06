param(
  [Parameter(Mandatory=$true)][string]$RepoPath,
  [Parameter(Mandatory=$true)][string]$TaskName,
  [string]$TaskPath  = "\ClaudeAutopilot\",
  [string]$ClaudeExe = "C:\Users\tecno\.local\bin\claude.exe"
)

# One-shot LOCAL cron run: re-source the 1136 clips that the old 2.0s guillotine
# cropped, replacing them with FULL-length clips (no cropping) per the corrected
# /character-creator rules. Then /next-ai-prompt + /close. Same launch model as the
# other autopilot wrappers (Interactive/Limited principal, profile PATH, Bypass).

$ErrorActionPreference = "Stop"

$logDir = Join-Path $RepoPath ".for_bepy\autopilot-resource"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$log   = Join-Path $logDir ("run_" + $stamp + ".log")
function Log($m) { Add-Content -Path $log -Value ("[" + (Get-Date -Format "HH:mm:ss") + "] " + $m) -Encoding utf8 }
Add-Content -Path (Join-Path $logDir "heartbeat.log") -Value ("[" + $stamp + "] autopilot-resource start (task=$TaskName)") -Encoding utf8

$prompt = @'
/autopilot Re-source every clip that the old 2.0s "guillotine" trim cropped, replacing each with a FULL-length clip - do NOT crop. The list of cropped clips is in `.for_bepy/cut_clips_report.csv` (columns: game,char,file,duration_s,tail_maxdB,reason; all 1136 rows with reason=capped are ~2.0s hard-cut and must be fixed). Follow the /character-creator skill, whose clip-length rules were just corrected.

For each cropped clip:
1. Re-acquire the FULL original voice line from the same kind of source the first batch used (HotS: jamiephan ogg packs + heroesofthestorm.fandom allimages; cartoons/sims/army-men/warcraft: archive.org voice rips, soundfxcenter, per /character-creator sound-sources.md). Prefer one bulk download per game, then extract the specific lines - do NOT do 1136 separate web hunts.
2. Replace the cropped file IN PLACE at `%APPDATA%\claude-usage-tauri\characters\<game>\<char>\sounds\<file>`, keeping the SAME filename so character.json slot references stay valid.
3. Apply the corrected length rules: NEVER truncate to a fixed length; <=5s keep whole (strip only leading/trailing pure silence); 5-10s keep whole but do NOT auto-ship - log it under a `## 5-10s clips pending approval` heading in COMMENTS_FOR_BEPY.md with its full path for Joe to approve by ear; >10s discard and find a shorter line instead.
4. Playable formats ONLY: WAV / MP3 / Ogg-Vorbis (verify any .ogg is vorbis not opus). No flac/opus/m4a.
5. If you genuinely cannot re-source a given clip, LEAVE the existing cropped file in place (do not delete it) and log it as unresolved in COMMENTS_FOR_BEPY.md.

Do NOT delete thin (<4 slot) characters in this run - Joe deferred that to a later pass. Character data lives OUTSIDE the git repo, so use RAW GIT for any in-repo bookkeeping commits (avoid the headless /commit test hang) during the re-source.

When the re-source is done: run `/next-ai-prompt` to write the next-session handoff, then run `/close` to do the session retrospective + persist. These two are an explicit instruction from Joe for the end of this run.
'@

try {
  Set-Location -Path $RepoPath
  Log "START repo=$RepoPath user=$(whoami)"
  $gitSrc = (Get-Command git -ErrorAction SilentlyContinue).Source
  Log "git on PATH: $gitSrc"
  if (-not $gitSrc) { Log "FATAL: git not on PATH (profile not loaded?). Aborting." ; throw "git missing" }
  if (-not (Test-Path $ClaudeExe)) { Log "FATAL: claude not found at $ClaudeExe" ; throw "claude missing" }

  Log "launching headless claude (/autopilot resource fix, bypassPermissions)"
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
