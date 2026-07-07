#!/usr/bin/env bash
# PreToolUse Bash guard (run via dispatch.sh): this repo is pnpm-only (see
# AGENTS.md). Blocks npm, yarn, bun, and bunx at a COMMAND position — the head of
# any segment. Segments split on ; && || | & newlines, subshells ( and command
# substitutions $( / backtick, but ONLY outside quotes — so a metacharacter inside a
# quoted argument (e.g. the commit message "fix (npm bug)") never shifts the head.
# Head detection skips leading VAR=val assignments, wrapper words (sudo, env, nice,
# xargs, timeout, setsid, doas, corepack, shell keywords, …), a value-taking wrapper
# flag value (sudo -u root, timeout -s KILL), redirections including glued forms
# (npm</dev/null, 2>&1), brace-group tokens { }, and option flags. `pnpm [--filter x]
# exec|dlx|x <cmd>` is unwrapped (repeatedly, so nested `pnpm exec pnpm exec npm` is
# caught) so `pnpm`/`npx` still pass and a message mentioning "npm" is not blocked.
# exit 2 = deny. Fails closed if node is missing or the hook JSON is unparseable.
#
# The lexer is shared with the sibling guards in _lexer.mts (one fix covers all three).
# Scope: defense-in-depth alongside AGENTS.md + human review, NOT a sandbox. Out of
# scope by design: a nested interpreter (sh -c / bash -c / python -c), ANSI-C escapes
# ($'\x6e...'), and UNLISTED wrapper words (proxychains/firejail/setarch/… — the WRAP
# allowlist cannot be exhaustive). A lexical guard cannot recurse into an interpreted
# string without becoming a shell itself.
set -uo pipefail

command -v node >/dev/null 2>&1 || { echo 'pnpm guard: node not found (required by this repo).' >&2; exit 2; }

exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deny-non-pnpm.mts"
