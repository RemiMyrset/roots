# Security policy

## Reporting a vulnerability

Please report security issues privately, not in public issues or pull requests.

Use GitHub's **Report a vulnerability** button under this repository's **Security**
tab (Security Advisories → private vulnerability reporting). If that is
unavailable, contact a maintainer listed on the repository's About page or in the
commit history.

Include: what you found, steps to reproduce, affected version or commit, and the
impact you expect. We aim to acknowledge a report within a few business days and
will coordinate a fix and disclosure timeline with you.

## PreToolUse guards — what they are (and are not)

The `.claude/hooks/` PreToolUse guards (`deny-non-pnpm`, `deny-build-scripts`,
`deny-secret-reads`) are **best-effort footgun-preventers for a cooperative agent, not a
sandbox.** They stop the common, accidental ways an agent would run a banned package
manager, enable a dependency build script, or read a secret file — mistakes worth catching
before they happen.

They are **not** a security boundary. A process actively trying to evade them can run a
nested interpreter (`sh -c '…'`), pipe through a decoder (`base64 -d | sh`), write a script
and execute it, or reach the same effect through any of the unbounded ways a shell can spell
a command. Deciding intent from command text alone is undecidable, so the guards do not try —
those classes are documented out-of-scope in each guard's header. **For real isolation, run
the agent under OS-level sandboxing** (a container, seccomp/AppArmor, a restricted `PATH`, or
a VM); the guards are defense-in-depth on top of that, never a replacement for it.

What they cover reliably is the direct and common wrapped forms: bare and path-prefixed
commands, standard wrappers (`sudo`, `env`, `nice`, `timeout`, `flock`, `xargs`, …) with
their ordinary flags, `pnpm exec` / `dlx` unwrapping, `;` / `&&` / `|` / `$()` separators, and
glued redirects. A regression suite (`pnpm test:hooks`) pins every covered case so a fix for
one form never silently reopens another.

## Secret-file protection

Two layers keep secrets out of the agent. The `.claude/settings.json` `permissions.deny`
Read-tool list enumerates common `.env*` / `secrets/` / `*.pem` / `*.key` names, and the
Bash-path guard `.claude/hooks/deny-secret-reads.sh` covers the common shell-read forms of an
`.env` file (and `.envrc`), anything under `secrets/`, and any `*.pem` / `*.key` — direct
readers, `<` redirects, `pnpm exec` wrappers, and `find -exec`. The guard is the broader of
the two (the Read list stays a curated subset so `.env.example` remains openable); both are
best-effort per the threat model above.

## Supported versions

This project tracks a single active line of development on the default branch.
Security fixes land there first; older tags are patched only when explicitly
noted in a release.
