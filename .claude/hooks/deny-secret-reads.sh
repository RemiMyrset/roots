#!/usr/bin/env bash
# PreToolUse Bash guard (run via dispatch.sh): the settings.json deny list stops
# the Read TOOL from opening secrets, but a shell reader (cat/head/grep/diff/read/
# mapfile/source/…) or a `<` redirect can read the same files. This narrows that
# gap. It fires when a file-READING command targets a protected path — a basename
# that is ".env", ".env" plus a separator (.env.local, .env-prod, .env~), or ".envrc"
# (matched case-insensitively; ".environment" is NOT matched; ".env.example" is exempt),
# anything under secrets/, or a *.pem / *.key file — or when a `<` redirect (including
# $(<file) and the <> read-write form) targets one, regardless of the head command. So
# a commit message, echo, or
# edit that merely mentions ".env" still passes. Head detection matches the other
# guards via the shared _lexer.mts (skips VAR=val, wrapper words, redirections incl
# glued forms, brace groups { } and option flags). exit 2 = deny. Fails closed if
# node is missing or the hook JSON is unparseable (node 24 is a hard requirement).
#
# Scope: BEST-EFFORT, lexical defense-in-depth alongside the settings.json Read-tool
# deny list and human review — NOT a sandbox and NOT a guarantee on the Bash path. It
# catches direct readers, `<` redirects, `pnpm exec` wrappers, and `find -exec` at a
# secret literal. It CANNOT catch (a lexical guard would have to become a shell): a
# nested interpreter (sh -c / bash -c / python -c), ANSI-C escapes ($'\x2eenv'), a
# recursive walker with no secret literal (`grep -r .`, `rg --no-ignore`), a filename
# routed via xargs or a stdin pipe, globs that expand to a secret without a ".env"
# prefix (`.e*`, `*.env`), and UNLISTED wrapper words (proxychains/firejail/…). For
# those, the backstop is .gitignore, the Read-tool deny list, and human review.
# Known over-block (safe direction, never a bypass): a printer whose secret-looking
# token is a SEARCH term or output PREFIX, not a read target — e.g. `look .env`,
# `split in .env_` — is denied though it reads no secret. Rephrase or run in a terminal.
set -uo pipefail

command -v node >/dev/null 2>&1 || { echo 'secret-read guard: node not found (required by this repo).' >&2; exit 2; }

exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deny-secret-reads.mts"
