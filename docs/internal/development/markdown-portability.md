# Markdown portability

Every file under `docs/`, plus the root `README.md` and `AGENTS.md`, must render
acceptably in **GitHub**, **VitePress**, and **Obsidian**. The rules below are
the contract; `pnpm docs:portability` enforces the machine-checkable subset and
CI blocks on violations. (`.claude/` and `.github/` files are out of scope —
their formats require YAML frontmatter.)

## Rules

1. **Links** — relative markdown links **with the `.md` extension**:
   `[text](./file.md)`, `[text](../dir/file.md#heading)`. The generated
   `docs/llms.txt` is the one non-`.md` target allowed. Never wikilinks
   (`[[page]]`) or embeds (`![[file]]`) — Obsidian-only. Never absolute
   `](/...)` links.
2. **Callouts** — only GitHub-alert syntax with the five UPPERCASE types:
   `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`.
   All three renderers style these natively. Never VitePress `:::` containers
   and never Obsidian's extended or foldable callout types.
3. **No YAML frontmatter** in docs. Metadata that matters lives in visible bold
   bullets (decision Status/Date, spec Source/Tests/Last reviewed) — frontmatter
   is invisible in VitePress and renders as a table on GitHub.
4. **Images** — store beside the doc (for example `./images/`), reference
   relatively: `![alt](./images/x.png)`. Never VitePress `public/`-rooted
   `/x.png` paths, never Obsidian embeds.
5. **Headings** — no backticks, emoji, or non-ASCII characters; keep
   punctuation minimal; unique text per file (slug algorithms diverge on
   collisions). The decision-record H1 format `NNNN. Title` is the sanctioned
   punctuation exception.
6. **Index files** — `index.md` inside `docs/` (VitePress convention, no
   rewrites). `README.md` only at repo root and `docs/README.md` (both outside
   the VitePress source directories).
7. **Mermaid** — standard fenced `mermaid` code blocks work everywhere
   (VitePress renders them via the bundled plugin).
8. **Emoji** — real Unicode characters, never `:shortcode:` colon codes
   (Obsidian renders those literally).
9. **HTML** — only `<details>`/`<summary>` and `<br>`. No script or style tags,
   no inline style attributes, and no bare `{`, `{{ }}`, or stray `<` in prose
   (VitePress compiles every page as a Vue template).
10. **Single-sourcing** — never VitePress `@include` or `<<<` snippet syntax;
    generate shared content with automd instead.
11. **Freely portable** — GFM tables (kept simple), task lists, footnotes,
    fenced code with language tags, standard emphasis, lists, and blockquotes.

Obsidian users: open `docs/` as the vault. The committed
`docs/.obsidian/app.json` sets markdown links on and relative link format, so
Obsidian emits rule-1-compliant links by default.
