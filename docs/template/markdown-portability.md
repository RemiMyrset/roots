# Markdown portability

Every file under `docs/`, plus the root `README.md` and `AGENTS.md`, must render
in GitHub, VitePress, and Obsidian. `pnpm docs:portability` enforces the
machine-checkable subset of the rules below and CI blocks on violations.
`.claude/` and `.github/` files are out of scope; their formats require YAML
frontmatter.

## Rules

1. **Links** are relative markdown links with the `.md` extension:
   `[text](./file.md)`, `[text](../dir/file.md#heading)`. Never wikilinks
   (`[[page]]`) or embeds (`![[file]]`), which are Obsidian-only, and never
   absolute `](/...)` links.
2. **Callouts** use only GitHub-alert syntax with the five UPPERCASE types:
   `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`.
   All three renderers style these natively. Never VitePress `:::` containers
   and never Obsidian's extended or foldable callout types.
3. **No YAML frontmatter** in docs. Metadata that matters lives in visible bold
   bullets (decision Status/Date, spec Source/Tests/Last reviewed); frontmatter
   is invisible in VitePress and renders as a table on GitHub.
4. **Images** live beside the doc (for example `./images/`) and are referenced
   relatively: `![alt](./images/x.png)`. Never VitePress `public/`-rooted
   `/x.png` paths, never Obsidian embeds.
5. **Headings** carry no backticks, emoji, or non-ASCII characters, minimal
   punctuation, and unique text per file (slug algorithms diverge on
   collisions). The decision-record H1 format `NNNN. Title` is the sanctioned
   punctuation exception.
6. **Index files** are `index.md` inside the two site directories (VitePress
   convention, no rewrites). `README.md` only outside them: the repo root,
   `docs/README.md`, and `docs/template/README.md`.
7. **Mermaid** works everywhere as standard fenced `mermaid` code blocks
   (VitePress renders them via the bundled plugin).
8. **Emoji** are real Unicode characters, never `:shortcode:` colon codes
   (Obsidian renders those literally).
9. **HTML** is limited to `<details>`/`<summary>` and `<br>`. No script or
   style tags, no inline style attributes, and no bare `{`, `{{ }}`, or stray
   `<` in prose (VitePress compiles every page as a Vue template).
10. **Single-sourcing** goes through automd; never VitePress `@include` or `<<<`
    snippet syntax.
11. GFM tables (kept simple), task lists, footnotes, fenced code with language
    tags, standard emphasis, lists, and blockquotes are **freely portable**.

Obsidian users open `docs/` as the vault. The committed
`docs/.obsidian/app.json` turns markdown links on with relative link format, so
Obsidian emits rule-1-compliant links by default.
