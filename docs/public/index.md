# Public documentation

The surface intended for the open web; the internal handbook is a separate
site.

## roots

A GitHub template for pnpm + Turborepo TypeScript monorepos that AI coding
agents can work in safely from day one.

- One rulebook, `AGENTS.md`, read by Claude Code, Codex, and Gemini CLI, and
  pre-tool guards that stop the common agent mistakes in all three.
- One done gate, `pnpm verify`, every CI check in CI order, on Linux, macOS,
  and Windows; CI runs it on Ubuntu and Windows.
- Decisions and specs with generated indexes that cannot drift, in portable
  markdown, rendered as an internal handbook and this public site.
- `pnpm sync:template`, which pulls the shared mechanics into a child, pins a
  branch or tag, and reports what changed.

The repository and rulebook are at
[github.com/RemiMyrset/roots](https://github.com/RemiMyrset/roots). Start with
[Getting started](./getting-started.md).

In your repository, replace this page and Getting started with your product's
docs, as the First run checklist in the README says.
