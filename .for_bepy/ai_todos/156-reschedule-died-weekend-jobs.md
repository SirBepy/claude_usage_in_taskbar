# Reschedule the two other died weekend autopilot jobs (hubbub, annoying_stopwatch)

## Goal
Re-arm the hubbub and annoying_stopwatch overnight /autopilot one-shots that died in the 2026-07-03 scheduler misfire, once Joe says when.

## Context
On 2026-07-03 16:49:34 all three pending /schedule-once tasks fired hours early during a Modern Standby transition, hit the exhausted session limit, and self-deleted (runner has since been hardened against both failure modes). This project's job was recovered and run on 2026-07-06; the other two were out of scope:
- hubbub: /autopilot overnight grind (ai_todos, NEXT_AI_PROMPT steps, port Split Opinions game into packages/games/split-opinions), bypassPermissions, fable high, workDir C:\Users\tecno\Desktop\Projects\hubbub, originally Fri 23:00.
- annoying_stopwatch: /autopilot ai_todos + research run ending in /commit pushnbump, acceptEdits, fable high, workDir C:\Users\tecno\Desktop\Projects\annoying_stopwatch, originally Sat 15:00.
Full verbatim prompts are in the sidecar dump inside transcript C:\Users\tecno\.claude\projects\C--Users-tecno-Desktop-Projects-hubbub\e33cd2b9-d808-470d-97ba-85127ff85080.jsonl (line 31 tool result) - recover them from there, do not paraphrase.

## Approach
Ask Joe for fire times (that is the one unguessable input), extract the two payloads verbatim from the transcript, then register each via `& "C:\Users\tecno\.claude\skills\schedule-once\schedule-once.ps1" -At "<time>" -WorkDir "<project>" -PermMode <mode> -Model fable -Effort high -Prompt '<payload>'` (single-quote the payload, double any embedded single quotes).

## Acceptance
Two tasks visible under `Get-ScheduledTask -TaskPath '\ClaudeOnce\*'` with the right fire times, sidecars present in %LOCALAPPDATA%\ClaudeScheduleOnce\jobs with mode/permMode/workDir matching the originals.
