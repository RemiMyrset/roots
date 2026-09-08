# Public documentation

The surface intended for the open web. The internal handbook is a separate site,
hosted only behind access control.

In the roots template this site is the template's own front door: what you get,
how to start, and where the rules live. In your repository, replace both pages
with your product's docs (installation, first use, a minimal working example),
as the First run checklist says, and keep them free of anything internal.

## roots

A GitHub template for pnpm + Turborepo TypeScript monorepos that AI coding
agents can work in safely from day one.

One rulebook, `AGENTS.md`, is read by Claude Code, Codex, and Gemini CLI, and
pre-tool guards stop the common agent mistakes in all three. One done gate,
`pnpm verify`, runs every CI check in CI order, on Linux, macOS, and Windows;
CI runs it on Ubuntu and Windows.

Decisions and specs cannot drift: generated indexes, portable markdown, an
internal handbook and this public site. Children pull the shared mechanics with
`pnpm sync:template`, pin a branch or tag, and read what changed.

The repository and rulebook are at
[github.com/RemiMyrset/roots](https://github.com/RemiMyrset/roots). Start with
[Getting started](./getting-started.md).
