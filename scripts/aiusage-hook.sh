#!/usr/bin/env bash
# Mirror of aiusage-hook.ps1 for macOS/Linux.
# Reads hook payload from stdin, appends originating-terminal env + PID chain,
# POSTs to the local app's hook server.

set -e
endpoint="${1:-refresh}"

body="$(cat)"
[ -z "$body" ] && body="{}"

# Walk parent PID chain (up to 10 deep)
chain=""
pid=$$
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -z "$pid" ] || [ "$pid" = "0" ] && break
  chain="${chain}${chain:+,}${pid}"
  parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  [ -z "$parent" ] && break
  pid="$parent"
done

origin=$(cat <<EOF
{"termProgram":"${TERM_PROGRAM:-}","vscodePipe":"${VSCODE_IPC_HOOK_CLI:-}","wtSession":"","ppidChain":[${chain}]}
EOF
)

# Merge origin into payload. Use python3 if available for safe JSON merge,
# else fall back to naive string injection (payload is trusted local input).
if command -v python3 >/dev/null 2>&1; then
  merged="$(BODY="$body" ORIGIN="$origin" python3 -c '
import json, os
try: obj = json.loads(os.environ["BODY"])
except Exception: obj = {}
if not isinstance(obj, dict): obj = {}
obj["origin"] = json.loads(os.environ["ORIGIN"])
print(json.dumps(obj))
')"
else
  trimmed="${body%\}}"
  [ "$trimmed" = "{" ] && merged="{\"origin\":${origin}}" || merged="${trimmed},\"origin\":${origin}}"
fi

curl -s -X POST -H "Content-Type: application/json" \
  --data-binary "$merged" \
  --max-time 2 \
  "http://127.0.0.1:27182/${endpoint}" >/dev/null 2>&1 || true
