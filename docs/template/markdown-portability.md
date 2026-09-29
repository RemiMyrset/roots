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
   absolute links, however spelled (`](/x)`, `]( /x)`, `](</x>)`, or the
   `/x` on the line after `](` or a reference's `]:`). The target
   must exist in the case written: macOS and Windows find `./agents.md` for
   `AGENTS.md`, Linux and GitHub do not. A space in a target is written `%20`
   or the target is wrapped in `<...>`, since GitHub ends an unbracketed target
   at the space; the checker decodes `%20` before it looks. The anchor must
   exist too: a `#fragment` into a markdown page (a bare `#fragment` means
   this page) must be the GitHub slug of one of its ATX headings. The slug is
   the heading text lowercased, with everything but letters, digits,
   underscores, hyphens, and whitespace dropped and each whitespace character
   turned into a hyphen; a repeated slug gets `-1`, `-2`. VitePress slugs a
   heading with inner punctuation or a leading digit differently, so do not
   anchor into one.
2. **Callouts** use only GitHub-alert syntax with the five UPPERCASE types:
   `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`.
   All three renderers style these natively. The checker rejects any other
   type, a lowercase one, Obsidian's foldable `]+` and `]-` forms, and a title
   after the bracket, which GitHub renders as a plain quote. Never VitePress
   `:::` containers.
3. **No YAML frontmatter** in docs. Metadata that matters lives in visible bold
   bullets (decision Status/Date, spec Source/Tests/Last reviewed); frontmatter
   is invisible in VitePress and renders as a table on GitHub. The cost is
   that `docs/public/index.md` is a plain page on purpose: a VitePress hero
   needs frontmatter and would not render on GitHub.
4. **Images** live beside the doc (for example `./images/`) and are referenced
   relatively: `![alt](./images/x.png)`. Never VitePress `public/`-rooted
   `/x.png` paths, never Obsidian embeds. A page under `docs/public/` links and
   embeds nothing outside `docs/public/`: the public build bundles what a page
   embeds, so an image from `docs/internal/` would be published. The build
   follows symlinks, so the checker refuses one under `docs/public/` that
   leads out of it, a page or a directory, and resolves each link through
   them. A link to `docs/public/` itself, such as `[home](./)`, is inside.
5. **Headings**: exactly one H1 per page, and unique text per file. The
   checker keys on the GitHub slug, so two headings that differ only in case or
   punctuation are duplicates. Backticks, emoji, and non-ASCII characters in a
   heading are a warning, not an error: slug algorithms diverge on them. Keep
   punctuation minimal; the legacy decision-record H1 format `NNNN. Title` is
   the sanctioned exception, and a dated record's H1 is the title alone.
6. **Index files** are `index.md` inside the two site directories,
   `docs/internal` and `docs/public` (VitePress convention, no rewrites), and
   `README.md` everywhere else: the repo root, `docs/README.md`, and
   `docs/template/README.md`. The checker rejects the other name in either
   place.
7. **Mermaid** works everywhere as standard fenced `mermaid` code blocks.
   GitHub and Obsidian render them natively; the internal site through the
   bundled plugin; the public site only once its config export is wrapped in
   `withMermaid()` the way the internal config is, because the plugin preloads
   about 500 KB of diagram code on every visit and ships off until a public
   page needs it.
8. **Emoji** are real Unicode characters, never `:shortcode:` colon codes
   (Obsidian renders those literally).
9. **HTML** is limited to `<details>`/`<summary>` and `<br>`; the checker
   rejects every other tag, one whose attributes run onto the next line
   included. Inline code is exempt on every line it spans: a generic type in
   backticks that wraps onto the next line is code, not a tag. VitePress
   compiles every page as a Vue template
   and evaluates two opening braces in a row as an interpolation, in inline
   code as much as in prose, so the checker rejects them anywhere but fenced
   code: show one in a fenced block. A single brace, or a `<` that opens no
   tag, renders as plain text.
10. **Single-sourcing** goes through automd; never VitePress `@include` or `<<<`
    snippet syntax.
11. GFM tables (kept simple), task lists, footnotes, fenced code with language
    tags, standard emphasis, lists, and blockquotes are **freely portable**.
    The checker skips fenced code at the top level, in a blockquote, and in a
    list item at the item's indent; code indented four spaces instead of fenced
    is checked as prose.

Obsidian users open `docs/` as the vault. The committed
`docs/.obsidian/app.json` turns markdown links on with relative link format, so
Obsidian emits rule-1-compliant links by default, a pasted image's spaces
written as `%20`.
