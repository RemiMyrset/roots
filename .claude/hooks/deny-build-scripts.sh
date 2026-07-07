#!/usr/bin/env bash
# PreToolUse Bash guard (run via dispatch.sh): block every pnpm path that runs
# dependency build/postinstall scripts — approve-builds, --allow-build,
# --dangerously-allow-all-builds, dangerouslyAllowAllBuilds. These are the
# code-execution step a supply-chain payload needs. exit 2 = deny; this overrides
# any permission prompt, so the action stays human-only by design: run it
# yourself in a terminal. Fails closed if node is missing or the hook JSON is
# unparseable (node 24 is required).
#
# Command-position detection matches deny-non-pnpm.sh (shared _lexer.mts): pnpm must
# be the head of a segment (after VAR=val, wrapper words, redirections incl glued
# forms, brace groups { }, and option flags), so a leading redirect/brace/flag cannot
# hide it and a message that merely mentions "approve-builds" is not blocked.
#
# Scope: defense-in-depth alongside AGENTS.md + human review, NOT a sandbox. Out of
# scope by design: a nested interpreter (sh -c / bash -c / python -c), ANSI-C escapes
# ($'...'), and unlisted wrapper words (the WRAP allowlist cannot be exhaustive).
set -uo pipefail

command -v node >/dev/null 2>&1 || { echo 'build-scripts guard: node not found (required by this repo).' >&2; exit 2; }

exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deny-build-scripts.mts"
