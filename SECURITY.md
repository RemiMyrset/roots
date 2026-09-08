# Security policy

## Reporting a vulnerability

Report security issues privately, never in a public issue or pull request.

Use GitHub's **Report a vulnerability** button under this repository's
**Security** tab (Security Advisories, private vulnerability reporting). If that
is unavailable, contact a maintainer listed on the repository's About page or in
the commit history.

Include what you found, steps to reproduce, the affected version or commit, and
the impact you expect. We aim to acknowledge a report within a few business days
and will coordinate a fix and disclosure timeline with you.

## Supported versions

This project tracks a single active line of development on the default branch.
Security fixes land there first; older tags are patched only when a release
says so.

## Agent guards

The pre-tool guards that keep AI agents from the common mistakes (a banned
package manager, dependency build scripts, secret reads, protected-branch
pushes, git-hook bypasses) are best-effort footgun-preventers, not a sandbox.
The threat model, scope, and server-side boundaries behind them are in
[docs/template/guards.md](./docs/template/guards.md).
