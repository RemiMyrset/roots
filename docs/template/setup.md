# Setup

What a machine needs before `pnpm install` works in roots or in any
repository made from it.

Install node 24, the version `.node-version` pins, and pnpm. On node 24,
`corepack enable` provides pnpm; on node 25 and later, install pnpm standalone
(`npm i -g pnpm`). Either way pnpm honours the version `packageManager` pins in
`package.json`.

Linux, macOS, and Windows all work, and CI runs on Ubuntu and Windows. On
Windows, install Git for Windows, since Claude Code runs its shell through Git
Bash, and Docker Desktop for the devcontainer
([Sandbox agents in a devcontainer](./docs-toolchain.md#sandbox-agents-in-a-devcontainer)).

Then, from the repository root:

```sh
pnpm install
```

Start Claude Code and Gemini CLI at the repository root and say yes to every
agent tool's trust prompts, Codex's prompt for each hook included, or the
guards stay off
([Trust and registration](./agent-surfaces.md#trust-and-registration)).
