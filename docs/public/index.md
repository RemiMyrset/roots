# Public documentation

The surface intended for the open web. The internal handbook is a separate site,
hosted only behind access control.

In the roots template this site is the template's own front door: what you get,
how to start, and where the rules live. In your repository, replace both pages
with your product's docs (installation, first use, a minimal working example)
— it is on the First run checklist — and keep them free of anything internal.

## roots

A GitHub template for pnpm + Turborepo TypeScript monorepos that AI coding
agents can work in safely from day one.

- **One rulebook, three tools.** `AGENTS.md` is read by Claude Code, Codex, and
  Gemini CLI; pre-tool guards stop the common agent mistakes in all three.
- **One done gate.** `pnpm verify` runs every CI check in CI order, on Linux,
  macOS, and Windows.
- **Decisions and specs that cannot drift.** Generated indexes, portable
  markdown, an internal handbook and this public site.
- **Template sync.** Children pull the shared mechanics with
  `pnpm sync:template`, pin a release, and read what changed.

Repository and rulebook: [github.com/RemiMyrset/roots](https://github.com/RemiMyrset/roots).
Start with [Getting started](./getting-started.md).
