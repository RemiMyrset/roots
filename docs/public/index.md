# roots

A GitHub template for pnpm + Turborepo TypeScript monorepos that AI coding
agents can work in safely from day one.

- One rulebook, `AGENTS.md`, read by Claude Code, Codex, and Gemini CLI, and
  pre-tool guards that stop the common agent mistakes in all three.
- One done gate, `pnpm verify`, every CI check in CI order, on Linux, macOS,
  and Windows; CI runs the same steps on Ubuntu and Windows.
- A docs system: decisions and specs in portable markdown, listed from the
  files so no list drifts or conflicts, rendered as an internal handbook; this
  public site is a separate build that holds none of them.
- `pnpm sync:template`, which pulls the template-owned files into a repository
  made from roots, pins a branch or tag, and reports what changed.

The repository and rulebook are at
[github.com/RemiMyrset/roots](https://github.com/RemiMyrset/roots). Start with
[Getting started](./getting-started.md).

In your repository, replace this page and Getting started with your product's
docs, as the First run checklist in the
[README](https://github.com/RemiMyrset/roots#first-run) says.
