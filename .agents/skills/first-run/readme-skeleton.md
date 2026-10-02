# <slug>

[![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/<repo>/actions/workflows/ci.yml)

<pitch>

## Start here

- [Setup](./docs/template/setup.md) gets a machine to its first
  `pnpm install`.
- [AGENTS.md](./AGENTS.md) is the rulebook for people and agents alike, and
  its [Commands](./AGENTS.md#commands) list is the home of every command;
  `pnpm verify` is the done gate.
- [docs/README.md](./docs/README.md) maps the handbook, the public site, and
  the template-owned rules.
- The public site publishes to `https://<owner>.github.io/<repo>/` once Pages
  is enabled
  ([recipe](./docs/template/docs-toolchain.md#publish-the-public-site-on-github-pages)).

Made from [roots](https://github.com/RemiMyrset/roots); `pnpm sync:template`
pulls its updates.

## License

[MIT](./LICENSE)
