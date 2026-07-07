#!/usr/bin/env bash
# PreToolUse dispatcher: pipes the tool-call JSON to every guard script (*.sh) in
# this directory (run even without +x — see the fallback below). Registering only
# this dispatcher in .claude/settings.json (not
# each guard) means dropping a new guard into this folder needs no settings.json
# edit — the dispatcher discovers and runs it. Any guard exiting non-zero denies
# the tool call (exit 2, fail closed). Guards parse the JSON with node (node 24
# is a hard repo requirement), so there is no external jq dependency.
set -uo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
input="$(cat)"

for hook in "$dir"/*.sh; do
  [ "$hook" = "$dir/dispatch.sh" ] && continue
  # Run each guard even if its executable bit was lost (a dropped +x must not
  # silently disable a security guard — fail closed, not open).
  if [ -x "$hook" ]; then
    runner=("$hook")
  else
    runner=(bash "$hook")
  fi
  if ! printf '%s' "$input" | "${runner[@]}"; then
    exit 2
  fi
done
exit 0
