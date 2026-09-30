/**
 * Portability guard: every markdown doc must render acceptably in GitHub,
 * VitePress, AND Obsidian. Blocking. A lint, not a build.
 *
 * The full human-readable ruleset lives in
 * docs/template/markdown-portability.md — error messages cite it.
 * Scope: docs/** plus root README.md and AGENTS.md. Never .claude/ or .github/
 * (their files require YAML frontmatter, which is banned in docs/).
 *
 * Beyond the banned-token scan: a relative link target must exist with the case written
 * (percent-encoding decoded, a raw space refused) and a `#fragment` into a markdown page (the
 * page's own included) must be the GitHub slug of one of its ATX headings; a page under
 * docs/public links and embeds nothing outside it, holds no automd region that reads outside
 * it, and no symlink there leads out, since the build follows symlinks; a page has exactly one
 * H1; a callout is one of the five uppercase GitHub alerts, unfolded and untitled; and an
 * index page is named for where it lives (rule 6). Blocks are read as VitePress 1.6.4 reads
 * them before their text is: a paragraph ends where markdown-it ends one, at a table's header
 * row and at an HTML block's start among the rest, and a lazy line keeps its paragraph's quote
 * and list item; a table row splits at its pipes before a cell is read; and an HTML block's
 * lines are HTML, holding no code span and no fence. Fenced code is skipped, at the top level,
 * in a list item, and in a blockquote; so is inline code on every line of its paragraph it
 * spans, and an HTML comment. A `<!--` that starts a line's content, on a line that heads no
 * table, opens an HTML block, which hides lines to its `-->` or to the end of the quote or list
 * item holding it. Anywhere else a comment is read by the inline grammar of VitePress's
 * markdown-it: text with no `--` closed by a `-->` in the same paragraph or table cell, after a
 * `<` no backslash escapes and that no code span, link destination, or link title opened first
 * holds; else the `<!--` is text, and so is what follows it. Three layouts are read loosely and
 * can hide text VitePress shows: a quote opened after a list marker, a quote's later line whose
 * `>` is indented four or more, and a backtick in a link's destination or title. Two scans read
 * the raw text instead, because their tool does: a VitePress `@include`, which VitePress
 * expands before markdown parses the page, in code and across lines, and an automd region on a
 * public page, which automd fills wherever its markers stand. A link destination may start on
 * the next line, or a title follow it there, and a reference definition counts inside a
 * blockquote or a list item too, with an escaped bracket in its label or a label that wraps; on
 * a public page a `[^label]:` one counts as well, since VitePress bundles no footnote plugin. A
 * tab in an indent counts to the next multiple of four columns.
 *
 * Adapted from an earlier internal docs-portability checker.
 */
import type { FenceState } from './root.mts'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ATX_HEADING_RE, automdRegions, blockStart, CLOSING_HASHES_RE, DECISIONS_DIR, expandTabs, fenceContinues, fenceOpens, githubSlug, pathCase, repoRoot, SKIP_DIRS, slugsOf, SPECS_DIR, WARN } from './root.mts'
import { posixRelative } from './skills.mts'

const RULES_DOC = 'docs/template/markdown-portability.md'

// `raw` entries are tested before inline code is scrubbed: the token is live even there.
const BANNED: { re: RegExp, msg: string, raw?: true }[] = [
  { re: /\[\[/, msg: 'Obsidian wikilink "[[" — use a relative [text](./file.md) link (rule 1)' },
  // NB: @include is NOT here: VitePress expands it before markdown parses the page, so it is
  // read on the raw text (INCLUDE_RE). `<<<` is a markdown block, so it embeds a file from a
  // list item or a quote as well as from the top level, however many spaces follow a marker.
  { re: /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+|>\s*)*<<</, msg: 'VitePress code snippet "<<<" — paste the snippet or link the source (rule 10)' },
  { re: /^\s*:::/, msg: 'VitePress container ":::" — use a GitHub-style "> [!NOTE]" alert (rule 2)' },
  { re: /\]\(\/[^)]/, msg: 'absolute link "](/...)" — use a relative path (rule 1)' },
  // Lookarounds keep prose like `docs:internal:dev` or 12:30:45 from matching:
  // a real shortcode is not adjacent to another word/colon segment. The body needs a
  // letter or digit, so a centered table cell `:---:` is not one while `:-1:` is.
  { re: /(?<![\w:]):(?=[a-z0-9_+-]*[a-z0-9])[a-z0-9_+-]+:(?![\w:])/, msg: 'emoji shortcode — use the real Unicode character (rule 8)' },
  // VitePress puts v-pre on fenced code only, so "{{" inside inline code is evaluated too.
  { re: /\{\{/, raw: true, msg: 'Vue interpolation "{{" — VitePress compiles every page as a Vue template and evaluates "{{ ... }}" even inside inline code; show it in fenced code (rule 9)' },
  { re: /<\/?(?!(?:details|summary|br)\b)[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>/i, msg: 'raw HTML tag beyond <details>/<summary>/<br> — renders inconsistently across GitHub / VitePress / Obsidian (rule 9)' },
  // The same tag with its attributes running onto the next line: the `>` is not on this one.
  { re: /<\/?(?!(?:details|summary|br)\b)[a-z][a-z0-9-]*(?:\s[^<>]*)?$/i, msg: 'raw HTML tag beyond <details>/<summary>/<br>, split across lines — renders inconsistently across GitHub / VitePress / Obsidian (rule 9)' },
]
const SETEXT_RE = /^ {0,3}(?:=+|-+)\s*$/
// The same run read from a line's content, the run in group 1.
const UNDERLINE_RE = /^(=+|-+)[ \t]*$/
// Leading blockquote markers, stripped before fence/BANNED scans so a fenced code
// block inside a `> [!NOTE]` alert (`> ```yaml`) is recognized as code, not scanned.
const BLOCKQUOTE_RE = /^ {0,3}(?:> ?)+/
// A blockquote opening past a container's content column, as in a list item, where the line's
// own markers (BLOCKQUOTE_RE) are not: it ends the paragraph above.
const QUOTE_START_RE = /^ {0,3}>/
// A block-level previous line (blockquote/list) turns a following `---`/`===` into a
// thematic break, not a setext heading underline.
const BLOCK_PREFIX_RE = /^ {0,3}(?:>|[-*+] |\d+[.)] )/
// A callout opener: the type inside `> [!TYPE]` is group 1; the rest of the line (Obsidian's
// fold marker or a title) is group 2. Matched with the blockquote prefix in place so a
// backticked example (`> `[!tip]``) is not one.
const ALERT_RE = /^ {0,3}(?:> ?)+\[!([^\]\n]*)\](.*)$/
const ALERT_TYPES: ReadonlySet<string> = new Set(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'])
// A comment as an HTML block holds it, from `<!--` to the first `-->` whatever lies between.
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
// A `<!--` whose `<` no odd run of backslashes escapes: `\<!--` is text.
const COMMENT_OPEN_RE = /(?<!(?<!\\)(?:\\\\)*\\)<!--/
// A comment inside a paragraph, a heading, or a table cell, tried where its `<!--` stands
// (sticky), as VitePress 1.6.4's inline HTML rule reads one: `<!---->`, or text that starts
// with neither `>` nor `->` and holds no `--`, then `-->`. Else the `<!--` is text, and so is
// what follows it. A table row is split at its pipes first (tableRow).
const INLINE_COMMENT_RE = /<!---->|<!---?[^>-](?:-?[^-])*-->/y
// A table's delimiter row from its first non-space character, as markdown-it 14 reads one: two
// characters at least, each a `|`, `:`, `-`, space, or tab, and no `- ` start, a list item's.
// Its cells (DELIMITER_CELL_RE) set the table's column count.
const DELIMITER_ROW_RE = /^(?!-[ \t])[|:-][|:\- \t]+$/
const DELIMITER_CELL_RE = /^:?-+:?$/
// The pipe markdown-it splits a table row at: any but one right after a backslash, inside a
// code span too.
const CELL_PIPE_RE = /(?<!\\)\|/
const CELL_PIPE_SPLIT_RE = /((?<!\\)\|)/
// A line that ends the table above it (with an empty line, a line of another quote depth, and
// one less indented than the table): a fence, a thematic break, a list item, or an ATX heading,
// read from the first non-space character; and an HTML block's start (htmlBlockAt).
const TABLE_END_RE = /^(?:`{3,}[^`]*$|~{3,}|([-*_])(?:[ \t]*\1){2,}[ \t]*$|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)|#{1,6}(?:[ \t]|$))/
// VitePress 1.6.4's inline tags (its componentPlugin's TAGS_INLINE), less `iframe`, which its
// block list claims first, and less `template` and `slot`, which it reads as Vue components.
// Matched in the case written: `<SPAN>` is a component.
const INLINE_TAGS: ReadonlySet<string> = new Set(['a', 'abbr', 'acronym', 'audio', 'b', 'bdi', 'bdo', 'big', 'br', 'button', 'canvas', 'cite', 'code', 'data', 'datalist', 'del', 'dfn', 'em', 'embed', 'i', 'img', 'input', 'ins', 'kbd', 'label', 'map', 'mark', 'meter', 'noscript', 'object', 'output', 'picture', 'progress', 'q', 'ruby', 's', 'samp', 'script', 'select', 'small', 'span', 'strong', 'sub', 'sup', 'svg', 'textarea', 'time', 'u', 'tt', 'var', 'video', 'wbr'])
// The HTML blocks VitePress starts, read from a line's first non-space character, each with what
// the line that closes it holds: an opening `<script`, `<pre`, or `<style` closes at its closing
// tag, `<?` at `?>`, `<!X` (X uppercase) at `>`, and CDATA at `]]>`.
const RAW_TEXT_OPEN_RE = /^<(?:script|pre|style)(?=[\s>]|$)/i
const RAW_TEXT_CLOSE_RE = /<\/(?:script|pre|style)>/i
const MARKUP_BLOCKS: ReadonlyArray<readonly [RegExp, RegExp]> = [[/^<\?/, /\?>/], [/^<![A-Z]/, />/], [/^<!\[CDATA\[/, /\]\]>/]]
// A tag at a line's start, its name in group 1: one not inline starts a block.
const TAG_OPEN_RE = /^<\/?([a-z][a-z0-9-]*)(?=\s|\/?>|$)/i
// A line holding one open or close tag and nothing more, `<br>` among them: VitePress starts a
// block there too, but only where a block starts, never inside a paragraph.
const LONE_TAG_RE = /^(?:<[a-z][a-z0-9-]*(?:\s+[\w:@][\w:.-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[a-z][a-z0-9-]*\s*>)\s*$/i
// An inline link's or image's label, then its destination and title (group 1), as markdown-it
// reads them: before any comment opener the destination or title holds, so a `<!--` there is
// text. The label nests one level of brackets; the title may wrap onto the next lines.
const LINK_TAIL_RE = /(?<!(?<!\\)(?:\\\\)*\\)\[(?:[^[\]\\]|\\[\s\S]|\[(?:[^[\]\\]|\\[\s\S])*\])*\](\(\s*(?:(?:<(?:[^<>\n\\]|\\.)*>|(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))+)(?:\s+(?:(?:"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|\((?:[^()\\]|\\[\s\S])*\))\s*)?)?)?\))/dg
const TICK_RE = /`/g
// VitePress expands `<!-- @include: path -->` with a regex over the raw page before markdown
// parses it: inside fenced and inline code too, and with the path on a later line. Rule 10
// bans every include, so each match is reported, wherever it stands.
const INCLUDE_RE = /<!--\s*@include/gi
// A bare argument value automd's reader (destr) turns into a falsy value, which names no file:
// file then fails, and dir-tree lists the page's own directory as it does without a `src`.
const FALSY_ARG_RE = /^(?:null|undefined|false|nan|-?0(?:\.0+)?(?:e[+-]?\d+)?)$/i
const WHITESPACE_RUN_RE = /\s+/g
// Applied once a key is upper-cased, which turns a long s (`ſ`) into `S` as camelCase does.
const NOT_UPPER_ALNUM_RE = /[^A-Z\d]/g
// The template's own generators read the handbook, so their regions list docs/internal.
const HANDBOOK_GENERATORS: ReadonlyMap<string, string> = new Map([['decisionsIndex', DECISIONS_DIR], ['specIndex', SPECS_DIR]])
// Line endings are normalized on read, so a CRLF file (written on Windows before git
// normalizes it) reads as the LF checkout will: the heading grammar ends in `$`.
const CRLF_RE = /\r\n/g
// Backtick runs must match in length (CommonMark), so ``a `b` c`` parses as one
// span. The body is [^\n]+? (min 1, single line): bounding it to one line stops
// a stray backtick from pairing with a distant one across the joined document
// and blanking every real link in between. A zero-length body could never
// satisfy the trailing (?<!`) anyway, since the char before it is the opener. An
// opening backtick after an odd number of backslashes is escaped, a literal backtick that
// opens nothing; a closing run needs no such guard, since a backslash inside code is text.
const INLINE_CODE_RE = /(?<!`)(?<!(?<!\\)(?:\\\\)*\\)(`+)(?!`)[^\n]+?(?<!`)\1(?!`)/g
// Any backtick run, as a code span's close: a closing run may follow a backslash.
const TICK_RUN_RE = /`+/g
// A backtick run left unpaired on its line, escape guarded as INLINE_CODE_RE's opener is: it
// opens a code span only when a later line of the paragraph holds a run of the same length
// (CommonMark), else it is a literal backtick.
const OPEN_RUN_RE = /(?<!(?<!\\)(?:\\\\)*\\)`+/g
// A line that ends a paragraph, and any code span or inline comment still open in it: blank,
// an ATX heading, a fence (a backtick one with no backtick in its info string), a setext
// underline or thematic break, or an HTML comment block (BLOCK_END_RE); or a list item
// (LIST_ITEM_RE). A list item at its paragraph's content column ends the paragraph only as a
// bullet or a `1.` with text after it (CommonMark, INTERRUPTING_ITEM_RE); any ends it from left
// of that column, or from a lazy line, where it ends the quote.
const BLOCK_END_RE = /^\s*$|^ {0,3}(?:#{1,6}(?:\s|$)|`{3,}[^`]*$|~{3,}|=+[ \t]*$|-+[ \t]*$|([-*_])(?:[ \t]*\1){2,}[ \t]*$|<!--)/
const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const INTERRUPTING_ITEM_RE = /^ {0,3}(?:[-*+]|1[.)])[ \t]+\S/
const PARAGRAPH_END_RE = new RegExp(`${BLOCK_END_RE.source}|${LIST_ITEM_RE.source}`)
// The quote and list markers a line opens with, and its indent. A reference definition after
// them is one: markdown-it collects it document-wide.
const CONTAINER_PREFIX_RE = /^[ \t]*(?:(?:>|[-*+][ \t]|\d{1,9}[.)][ \t])[ \t]*)*/
// The heading grammar is root.mts's ATX_HEADING_RE, shared with the anchor checker, so an
// indented heading or a closing hash run reads the same on both sides.
const HEADING_RE = ATX_HEADING_RE
const HEADING_BACKTICK_RE = /`/
const NON_ASCII_RE = /[^\x20-\x7E]/
const LINK_TARGET_RE = /\]\(([^)\n]+)\)/g
// A destination no `)` follows on its line, as when its title wraps onto the next line or
// starts there: the link is read from its destination alone.
const OPEN_TARGET_RE = /\]\(\s*(<[^<>\n]*>|[^\s()<][^\s()]*)(?=\s*$|\s+["'(][^)]*$)/g
// Tested once the container prefix is off (CONTAINER_PREFIX_RE). A definition is complete: its
// destination (group 2) ends the line or a title follows it. `[Term]: prose` is text, no
// definition. The label (group 1) may hold an escaped bracket. One that starts with `^` is a
// footnote on GitHub but a definition in VitePress, which bundles no footnote plugin.
const REF_DEF_RE = /^\[((?:\\.|[^\]\\])+)\]:\s*(<[^>\n]*>|\S+)(?=\s*$|\s+["'(])/
// A line ending before its link destination, which CommonMark lets start on the next line.
const INLINE_DEST_NEXT_RE = /\]\(\s*$/
const REF_DEST_NEXT_RE = /^\[(?:\\.|[^\]\\])+\]:\s*$/
// A line that opens a link label and does not close it: the label runs on through the next
// lines of its paragraph.
const LABEL_OPEN_RE = /^\[(?:\\.|[^\]\\])*\\?$/
const LINK_TITLE_RE = /\s+("[^"]*"|'[^']*')$/
const EXTERNAL_TARGET_RE = /^(?:https?:|mailto:)/
const WHITESPACE_RE = /\s/
// A root-absolute inline target as the BANNED scan sees it, written right after the paren.
const BANNED_ABSOLUTE_RE = /^\/[^)]/
// Pages the public site renders: a link or image from one may not leave its directory.
const PUBLIC_DIR = 'docs/public'
// The two VitePress sites, whose index page is index.md; everywhere else GitHub shows
// README.md. Tested on the posix-relative path, so the same on every platform.
const SITE_DIR_RE = /^docs\/(?:internal|public)\//

/** Where the first run of exactly `len` backticks in `text` ends, or -1 when it holds none. */
function runEnd(text: string, len: number): number {
  for (const m of text.matchAll(TICK_RUN_RE)) {
    if (m[0].length === len)
      return m.index + len
  }
  return -1
}

/** How many blockquotes a line opens. */
function quoteDepth(line: string): number {
  return (BLOCKQUOTE_RE.exec(line)?.[0].split('>').length ?? 1) - 1
}

/** `line` with its first `count` quote markers off, read as BLOCKQUOTE_RE reads them. */
function unquote(line: string, count: number): string {
  return count === 0 ? line : line.replace(new RegExp(`^ {0,3}(?:> ?){${count}}`), '')
}

/** The width of a line's indent, its tabs expanded (expandTabs) by the caller. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/**
 * The HTML block VitePress 1.6.4 starts at `text`, a line's content from its first non-space
 * character, given as what the line that closes it holds: a pattern, or null where an empty line
 * closes it. Undefined where none starts. Any tag but an inline one starts one, and so do `<?`,
 * `<!X` with X uppercase, CDATA, and an opening `<script`, `<pre`, or `<style`: each ends a
 * paragraph. A line holding one tag alone starts one only where a block starts (`lone`). A
 * comment's block is the caller's to read first.
 */
function htmlBlockAt(text: string, lone: boolean): RegExp | null | undefined {
  if (RAW_TEXT_OPEN_RE.test(text))
    return RAW_TEXT_CLOSE_RE
  for (const [open, close] of MARKUP_BLOCKS) {
    if (open.test(text))
      return close
  }
  const tag = TAG_OPEN_RE.exec(text)?.[1]
  return (tag !== undefined && !INLINE_TAGS.has(tag)) || (lone && LONE_TAG_RE.test(text)) ? null : undefined
}

/** How many columns the delimiter row `text`, from its first non-space character, sets, or 0 where it is none (DELIMITER_ROW_RE). */
function delimiterColumns(text: string): number {
  if (!DELIMITER_ROW_RE.test(text))
    return 0
  const cells = text.split('|')
  let count = 0
  for (const [k, cell] of cells.entries()) {
    const t = cell.trim()
    if (t === '' && (k === 0 || k === cells.length - 1))
      continue
    if (!DELIMITER_CELL_RE.test(t))
      return 0
    count++
  }
  return count
}

/**
 * Whether `head` is a table's header row with `below` its delimiter row, as markdown-it 14 reads
 * them: `head` holds a `|`, and splits at its pipes (CELL_PIPE_RE), an outer one on either side
 * dropped, into as many cells as the delimiter row sets columns. Both have their quote markers
 * off and their indents' tabs expanded; `below` is the caller's only at the same quote depth.
 * With `base`, the content column of their container, `head` stands at most three columns past
 * it and `below` from it to three past it; without, the indents go unchecked.
 */
function tableHead(head: string, below: string | undefined, base: number | undefined): boolean {
  if (below === undefined || !head.includes('|'))
    return false
  if (base !== undefined && (indentOf(head) - base > 3 || indentOf(below) < base || indentOf(below) - base > 3))
    return false
  const columns = delimiterColumns(below.trimStart())
  const cells = head.trim().split(CELL_PIPE_RE)
  if (cells[0] === '')
    cells.shift()
  if (cells.at(-1) === '')
    cells.pop()
  return columns > 0 && cells.length === columns
}

/**
 * The later lines of a paragraph, from `lines[from]` on, with their quote markers off: where a
 * code span, an inline comment, or a link's title opened above them may close. The paragraph,
 * quoted `depth` deep with its content at column `base`, ends at a line quoted deeper, at a
 * blockquote's start, at a PARAGRAPH_END_RE line (a list item only as LIST_ITEM_RE and
 * INTERRUPTING_ITEM_RE say), and, as VitePress reads it, at an HTML block's start (htmlBlockAt)
 * and at a table's header row (tableHead), which a lazy line, quoted less than `depth`, never
 * is. Such a line ends it only up to three columns past `base`. With `anyIndent` it ends at any
 * of them, or at a `>`, however far it is indented, as one in a nested list item does: what a
 * comment's `-->` may close. A comment the paragraph ends too soon for is read as text, so the
 * checker reads more; a code span's pairing would shift instead, so it is read without.
 */
function paragraphAfter(lines: string[], from: number, depth: number, base: number, anyIndent: boolean): string[] {
  const out: string[] = []
  for (let j = from; j < lines.length; j++) {
    const quote = quoteDepth(lines[j]!)
    const unquoted = lines[j]!.replace(BLOCKQUOTE_RE, '')
    const expanded = expandTabs(unquoted)
    // Read from the paragraph's content column, or from the first non-space character of a line
    // indented less. A lazy line quoted two or more less than the paragraph loses its indent:
    // markdown-it tests it against the inner quote's ends as if it had none.
    const relative = expanded.slice(Math.min(indentOf(expanded), base))
    const unindented = anyIndent || quote <= depth - 2
    const content = unindented ? expanded.trimStart() : relative
    const item = anyIndent || quote < depth || indentOf(expanded) < base ? LIST_ITEM_RE.test(content) : INTERRUPTING_ITEM_RE.test(content)
    if (quote > depth || (anyIndent ? content.startsWith('>') : QUOTE_START_RE.test(relative)) || item || BLOCK_END_RE.test(content))
      break
    const next = lines[j + 1]
    const below = next !== undefined && quoteDepth(next) === depth ? expandTabs(next.replace(BLOCKQUOTE_RE, '')) : undefined
    if ((unindented || indentOf(expanded) - base <= 3)
      && (htmlBlockAt(expanded.trimStart(), false) !== undefined || (quote === depth && tableHead(expanded, below, anyIndent ? undefined : base)))) {
      break
    }
    out.push(unquoted)
  }
  return out
}

/**
 * The offsets of `text`, a paragraph line, that an inline link's destination and title cover
 * (LINK_TAIL_RE), as [start, end) pairs, read with the paragraph's later lines (`later`), onto
 * which a title may wrap; and how far into each later line such a title reaches. A link that
 * starts on an earlier line is the caller's (`carry`).
 */
function linkTails(text: string, later: () => string[]): { spans: [number, number][], onward: number[] } {
  const spans: [number, number][] = []
  const onward: number[] = []
  if (!text.includes('['))
    return { spans, onward }
  const rest = later()
  const joined = [text, ...rest].join('\n')
  for (const m of joined.matchAll(LINK_TAIL_RE)) {
    const [start, end] = m.indices![1]!
    if (start >= text.length)
      break
    spans.push([start, Math.min(end, text.length)])
    // The later lines the tail reaches: each up to its end, the last one only partway.
    let at = text.length + 1
    for (const [k, line] of rest.entries()) {
      if (end <= at)
        break
      onward[k] = Math.max(onward[k] ?? 0, Math.min(end - at, line.length))
      at += line.length + 1
    }
  }
  return { spans, onward }
}

/** `text` with each [start, end) span of `spans` turned into spaces. */
function blankSpans(text: string, spans: [number, number][]): string {
  let out = text
  for (const [start, end] of spans)
    out = `${out.slice(0, start)}${' '.repeat(end - start)}${out.slice(end)}`
  return out
}

/** The length of what the sticky `re` matches at offset `at` of `text`, or undefined where it matches nothing. */
function matchAt(re: RegExp, text: string, at: number): number | undefined {
  re.lastIndex = at
  return re.exec(text)?.[0].length
}

/**
 * A paragraph line, a heading, or a table cell with each comment VitePress hides there taken
 * out, read from offset `from` (where a code span opened above it closes) left to right, as
 * markdown-it reads it. A code span on the line holds a `<!--` as text, and so does a backtick
 * run that a later line of the paragraph (`spans`) may close, along with all that follows it,
 * and so does a link's destination or title, at the offsets `links` lists. A `<!--` hides text
 * only where INLINE_COMMENT_RE matches: on the line, or across the later lines (`comments`),
 * when it hides the rest of the line and `open` is true. Anywhere else it is text. A comment
 * closed on the line turns into spaces, never into nothing, so the text on either side of it
 * stays apart, as it does in markdown-it: two backtick runs it parts never make a fence.
 */
function stripInlineComments(text: string, from: number, spans: () => string[], comments: () => string[], links: [number, number][] = []): { text: string, open: boolean } {
  let out = text.slice(0, from)
  let tail = text.slice(from)
  for (;;) {
    const masked = tail.replace(INLINE_CODE_RE, m => ' '.repeat(m.length))
    const shift = out.length
    const at = blankSpans(masked, links.map(([start, end]): [number, number] => [Math.max(start - shift, 0), Math.max(end - shift, 0)])).search(COMMENT_OPEN_RE)
    if (at === -1 || [...masked.slice(0, at).matchAll(OPEN_RUN_RE)].some(run => spans().some(l => runEnd(l, run[0].length) !== -1)))
      break
    const end = matchAt(INLINE_COMMENT_RE, tail, at)
    if (end === undefined && matchAt(INLINE_COMMENT_RE, [tail.slice(at), ...comments()].join('\n'), 0) !== undefined)
      return { text: `${out}${tail.slice(0, at)}`, open: true }
    out += end === undefined ? tail.slice(0, at + 4) : `${tail.slice(0, at)}${' '.repeat(end)}`
    tail = tail.slice(at + (end ?? 4))
  }
  return { text: `${out}${tail}`, open: false }
}

/**
 * A table row, quote markers off, as VitePress reads it: markdown-it splits the row at its
 * pipes (CELL_PIPE_RE) before it reads a cell, so a comment or a code span ends at a pipe. Each
 * cell's comments turn into spaces (`text`), and its code spans too (`scan`), with any backtick
 * left unpaired in its cell, so no later scan pairs it with one in another cell.
 */
function tableRow(row: string): { text: string, scan: string } {
  const none = (): string[] => []
  let text = ''
  let scan = ''
  for (const [k, part] of row.split(CELL_PIPE_SPLIT_RE).entries()) {
    const cell = k % 2 === 0 ? stripInlineComments(part, 0, none, none, linkTails(part, none).spans).text : part
    text += cell
    scan += k % 2 === 0 ? cell.replace(INLINE_CODE_RE, m => ' '.repeat(m.length)).replace(TICK_RE, ' ') : cell
  }
  return { text, scan }
}

/** The 1-based line of `text` that offset `at` falls on. */
function lineAt(text: string, at: number): number {
  let line = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1))
    line++
  return line
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name))
        out.push(...walk(join(dir, entry.name)))
    }
    else if (entry.name.endsWith('.md')) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

const root = repoRoot()
const docsDir = join(root, 'docs')
if (!existsSync(docsDir))
  console.log('  (docs/: not present, skipped)')
const files = [join(root, 'README.md'), join(root, 'AGENTS.md'), ...(existsSync(docsDir) ? walk(docsDir) : [])]
  .filter(f => existsSync(f) && statSync(f).isFile())

const problems: string[] = []
const warns: string[] = []

// The public site's directory as its build reads it, symlinks resolved; undefined until a
// public page links something.
let publicReal: string | undefined

/** Whether `dest`, which exists, is docs/public or inside it once symlinks are resolved: the build bundles the file a symlink names. */
function insidePublic(dest: string): boolean {
  publicReal ??= realpathSync(join(root, PUBLIC_DIR))
  const to = relative(publicReal, realpathSync(dest))
  return to !== '..' && !to.startsWith(`..${sep}`) && !isAbsolute(to)
}

/** Every symlink below `dir` that resolves outside docs/public: the public build follows it, a page or a directory alike, and publishes what it names. */
function publicEscapes(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      if (existsSync(at) && !insidePublic(at))
        out.push(at)
    }
    else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      out.push(...publicEscapes(at))
    }
  }
  return out
}

/**
 * The `src` values of an automd opener's arguments, read as automd reads them: split at
 * whitespace into `key=value`, the value through destr, which unquotes a double-quoted string.
 * automd camel-cases each key (scule), which keeps `src` for `Src`, `-src_`, and `ſrc` (a long
 * s upper-cases to `S`). A key counts when, upper-cased, its letters and digits spell `SRC`:
 * every key camelCase maps to `src`, and a few it does not, so none can shadow the one automd
 * uses. A value destr makes falsy names nothing and is dropped.
 */
function automdSources(args: string): string[] {
  const out: string[] = []
  for (const part of args.split(WHITESPACE_RUN_RE)) {
    const [key = '', value = ''] = part.split('=')
    if (!value || key.toUpperCase().replace(NOT_UPPER_ALNUM_RE, '') !== 'SRC')
      continue
    let src: string | undefined = value
    if (value.startsWith('"') && value.endsWith('"') && !value.includes('\\')) {
      src = value.slice(1, -1) || undefined
    }
    else if (FALSY_ARG_RE.test(value.trim())) {
      src = undefined
    }
    else if (value.startsWith('"')) {
      try {
        src = String(JSON.parse(value)) || undefined
      }
      catch {}
    }
    if (src !== undefined)
      out.push(src)
  }
  return out
}

/**
 * Where automd reads a region's `src`, resolved as its generators resolve it: a leading `/`
 * from the repository root, anything else relative to the page as a URL (so `%2e%2e` is `..`),
 * and jsimport's as a module from the repository root. Undefined when it names no file path.
 */
function automdTarget(generator: string, src: string, page: string): string | undefined {
  try {
    if (generator === 'jsimport')
      return isAbsolute(src) ? src : resolve(root, src)
    return src.startsWith('/') ? join(root, src) : fileURLToPath(new URL(src, pathToFileURL(page)))
  }
  catch {
    return undefined
  }
}

/**
 * Reports every automd region of the docs/public page `file` that reads outside docs/public:
 * one whose `src` resolves outside it or to nothing, and one of the handbook generators. A
 * region with no `src` otherwise reads no file, or, for dir-tree, lists the page's own
 * directory. Read on the raw text, since automd fills a region inside fenced code too, and
 * paired as automd pairs them (automdRegions): an opener inside an earlier region's body is
 * text, and automd fills no region that lacks a close.
 */
function checkPublicRegions(where: string, file: string, text: string): void {
  for (const region of automdRegions(text)) {
    if (!region.closed)
      continue
    const [generator, args] = [region.name, region.args.replace(WHITESPACE_RUN_RE, ' ').trim()]
    const at = `${where}:${lineAt(text, region.start)}`
    const opener = `<!-- automd:${[generator, args].filter(Boolean).join(' ')} -->`
    const fix = `the public site would publish what it reads; keep its source inside ${PUBLIC_DIR} (rule 4)`
    const handbook = HANDBOOK_GENERATORS.get(generator)
    if (handbook !== undefined)
      problems.push(`${at}  automd region reads outside ${PUBLIC_DIR}: ${opener} lists ${handbook} — ${fix}`)
    for (const src of automdSources(args)) {
      const target = automdTarget(generator, src, file)
      if (target === undefined || !existsSync(target))
        problems.push(`${at}  automd region reads outside ${PUBLIC_DIR}: ${opener} names ${src}, which does not exist — ${fix}`)
      else if (!insidePublic(target))
        problems.push(`${at}  automd region reads outside ${PUBLIC_DIR}: ${opener} reads ${posixRelative(root, target) || '. (the repository root)'} — ${fix}`)
    }
  }
}

if (existsSync(join(root, PUBLIC_DIR))) {
  // Relative to the root's own real path, which a symlinked or short-named temp directory changes.
  const rootReal = realpathSync(root)
  for (const at of publicEscapes(join(root, PUBLIC_DIR)))
    problems.push(`${posixRelative(root, at)}  symlink to ${posixRelative(rootReal, realpathSync(at))}, outside ${PUBLIC_DIR} — the public build follows it and would publish what it names; copy the files into ${PUBLIC_DIR} (rule 4)`)
}

// Per-page heading state: slug -> first line, plus the line of the first H1.
interface Page { where: string, headings: Map<string, number>, h1Line: number | undefined }

function recordHeading(page: Page, headingText: string, level: number, lineNo: number): void {
  // Keyed on the GitHub slug, so two headings that differ only in punctuation or case
  // collide here as their anchors would.
  const key = githubSlug(headingText)
  const prev = page.headings.get(key)
  if (prev !== undefined)
    problems.push(`${page.where}:${lineNo}  duplicate heading "${headingText}" (also line ${prev}) — slug dedupe differs per renderer (rule 5)`)
  else
    page.headings.set(key, lineNo)
  if (level === 1) {
    if (page.h1Line === undefined)
      page.h1Line = lineNo
    else
      problems.push(`${page.where}:${lineNo}  second H1 "${headingText}" (first at line ${page.h1Line}) — one H1 per page (rule 5)`)
  }
  if (HEADING_BACKTICK_RE.test(headingText) || NON_ASCII_RE.test(headingText))
    warns.push(`${page.where}:${lineNo}  heading with backticks or non-ASCII — slug algorithms diverge (rule 5)`)
}

// GitHub anchors per markdown file, read once: a page is a link target many times over.
const slugCache = new Map<string, ReadonlySet<string>>()

function anchorsOf(file: string): ReadonlySet<string> {
  const key = resolve(file)
  let slugs = slugCache.get(key)
  if (!slugs) {
    slugs = new Set(slugsOf(readFileSync(key, 'utf8').replace(CRLF_RE, '\n')))
    slugCache.set(key, slugs)
  }
  return slugs
}

/**
 * A link target's path read as a URL path: "My%20Doc.md" names "My Doc.md" (Obsidian writes
 * pasted image links this way). A malformed escape is kept as written.
 */
function decodePath(rel: string): string {
  try {
    return decodeURIComponent(rel)
  }
  catch {
    return rel
  }
}

/** Reports a link or image on a docs/public page whose target, which exists, lies outside docs/public. */
function reportOutsidePublic(where: string, display: string): void {
  problems.push(`${where}  link or image outside ${PUBLIC_DIR}: ${display} — the public site would publish it; copy the file into ${PUBLIC_DIR} or link it by URL (rule 4)`)
}

/**
 * Checks one link target: an inline link's, a reference definition's (`ref`), or a `[^label]:`
 * line's on a public page (`footnote`). GitHub reads that line as a footnote, whose text names no
 * file, and VitePress as a reference definition, since it bundles no footnote plugin: so only a
 * file it names outside docs/public is reported, and a missing one is no broken link.
 */
function checkLinkTarget(where: string, file: string, raw: string, display: string, kind: 'inline' | 'ref' | 'footnote'): void {
  // Normalize CommonMark link forms: optional title (./a.md "t") and angle
  // brackets (<./a b.md>).
  let target = raw.trim().replace(LINK_TITLE_RE, '')
  const angled = target.startsWith('<') && target.endsWith('>')
  if (angled)
    target = target.slice(1, -1)
  if (EXTERNAL_TARGET_RE.test(target))
    return
  const hash = target.indexOf('#')
  const rel = hash === -1 ? target : target.slice(0, hash)
  const fragment = hash === -1 ? '' : target.slice(hash + 1)
  if (kind === 'footnote') {
    const dest = resolve(dirname(file), decodePath(rel))
    if (rel && !rel.startsWith('/') && pathCase(root, dest) === 'exact' && !insidePublic(dest))
      reportOutsidePublic(where, display)
    return
  }
  if (rel.startsWith('/')) {
    // The BANNED scan reports an inline "](/path)" as written. Every other spelling that
    // normalizes to a root-absolute target is reported here: the bare root "](/)", a space
    // or angle brackets before the slash ("]( /x)", "](</x>)"), and a reference definition,
    // which that scan never covers.
    if (kind === 'ref')
      problems.push(`${where}  absolute link "${display}" — use a relative path (rule 1)`)
    else if (!BANNED_ABSOLUTE_RE.test(raw))
      problems.push(`${where}  root-absolute inline link "${display}" — use a relative path (rule 1)`)
    return
  }
  // GitHub ends an unbracketed target at the first space, so "](./My Doc.md)" is not a link
  // there; VitePress and Obsidian read it whole.
  if (kind === 'inline' && !angled && WHITESPACE_RE.test(target)) {
    problems.push(`${where}  link target with a space: ${display} — write the space as %20 or wrap the target in <...> (rule 1)`)
    return
  }
  const path = decodePath(rel)
  // A bare "#fragment" anchors into this page; a path with one anchors into that page.
  const dest = path ? resolve(dirname(file), path) : file
  if (path) {
    const found = pathCase(root, dest)
    if (found === 'missing') {
      problems.push(`${where}  broken relative link: ${display}`)
      return
    }
    if (found !== 'exact') {
      problems.push(`${where}  relative link in the wrong case: ${display} — on disk it is ${found}; a case-insensitive disk passes it, Linux and GitHub do not (rule 1)`)
      return
    }
    // The public build bundles what its pages link and embed, so a target outside docs/public
    // publishes internal content (an image from docs/internal) or breaks the build. The
    // directory itself is its home page.
    if (posixRelative(root, file).startsWith(`${PUBLIC_DIR}/`) && !insidePublic(dest))
      reportOutsidePublic(where, display)
  }
  // Only markdown pages have headings to anchor into; a fragment on an image or a
  // directory is left to the renderer.
  if (fragment && dest.endsWith('.md') && !anchorsOf(dest).has(fragment))
    problems.push(`${where}  broken anchor: ${target} (rule 1)`)
}

for (const file of files) {
  const where = posixRelative(root, file)
  const text = readFileSync(file, 'utf8').replace(CRLF_RE, '\n')
  const lines = text.split('\n')

  if (lines[0]?.trim() === '---')
    problems.push(`${where}:1  YAML frontmatter — metadata goes in visible bold bullets (rule 3)`)

  const name = basename(file)
  const inSite = SITE_DIR_RE.test(where)
  if (name === 'README.md' && inSite)
    problems.push(`${where}  README.md inside a site directory — VitePress serves index.md, name it that (rule 6)`)
  else if (name === 'index.md' && !inSite)
    problems.push(`${where}  index.md outside a site directory — GitHub shows README.md, name it that (rule 6)`)

  // Before any skip below: VitePress expands an include wherever it stands. Reported on the
  // line of its `@include` token.
  for (const m of text.matchAll(INCLUDE_RE)) {
    const at = lineAt(text, m.index + m[0].length)
    problems.push(`${where}:${at}  VitePress @include — VitePress expands it even in code and across lines; single-source via automd instead (rule 10)\n    ${lines[at - 1]!.trim()}`)
  }
  if (where.startsWith(`${PUBLIC_DIR}/`))
    checkPublicRegions(where, file, text)

  // Track fenced blocks, multi-line HTML comments, the other HTML blocks, and tables, and keep
  // the rendered ("visible") text of every line so link scanning below sees exactly what a
  // reader would — fence content and comments blanked, inline code preserved for now.
  const fences: FenceState = { lists: [] }
  // The quote depth of the open fence's opener, and of the line that last set the open list items.
  let fenceQuote = 0
  let listsQuote = 0
  // The comment open above this line. One an HTML block opened (`block`) ends with its
  // container too, so it keeps the quote depth and the content column the opener stood at; one
  // inside a paragraph closes in it (stripInlineComments), whatever its lines' markers.
  let comment: { block: boolean, quote: number, col: number } | undefined
  // The HTML block other than a comment's open above this line (htmlBlockAt): its quote depth,
  // its container's content column, and what the line closing it holds (null: an empty line).
  let html: { quote: number, col: number, close: RegExp | null } | undefined
  // The table open above this line: its quote depth, its container's content column, and
  // whether its delimiter row is the next line.
  let table: { quote: number, base: number, delimiter: boolean } | undefined
  // Whether the line above is a paragraph's text, which a lone tag's line continues instead of
  // opening an HTML block; and the line's quote depth, which a quote it opens runs on below.
  let prevText = false
  let prevQuote = 0
  // The quote depth and the content column of the paragraph the line above is text of: a line
  // that continues it keeps them, a lazy one too.
  let prevParaQuote = 0
  let prevParaBase = 0
  // How far a link's title, opened on an earlier line, reaches into a later one, by line index.
  const linkCarry = new Map<number, number>()
  // The backtick run of an inline code span opened on an earlier line of this paragraph.
  let openTicks: number | undefined
  let prevVisible = ''
  const visibleLines: string[] = []
  const page: Page = { where, headings: new Map(), h1Line: undefined }
  // A line that shows nothing the checks read: a fence marker or body, or a comment line.
  const blank = (): void => {
    visibleLines.push('')
    prevVisible = ''
    openTicks = undefined
    prevText = false
  }

  lines.forEach((line, i) => {
    const depth = quoteDepth(line)
    const aboveQuote = prevQuote
    prevQuote = depth
    // Inside a fence nothing renders as markup. Only a fence of the SAME
    // character and AT LEAST the opener's length closes it (CommonMark).
    if (fences.fence) {
      // A fence opened inside a blockquote cannot outlive the quote (CommonMark): if the quote
      // has ended — this line carries fewer `>` markers than the fence's opener (none, for blank
      // or plain prose) — close the fence and fall through to scan this line normally, instead
      // of latching fence-state to EOF. A fence in a list item ends with the item the same way
      // (fenceContinues). Only the opener's own markers are stripped from a line, so a
      // body line holding a literal `> ```` line, in a quoted fence or a plain one, is not
      // closed early.
      if (depth < fenceQuote)
        fences.fence = undefined
      else if (fenceContinues(fences, unquote(line, fenceQuote)))
        return blank()
    }
    let visible = line
    const unquotedLine = expandTabs(line.replace(BLOCKQUOTE_RE, ''))
    const empty = unquotedLine.trim() === ''
    const indent = indentOf(unquotedLine)
    // An empty line ends a table and an HTML block that runs to one, at the block's own quote
    // depth (a deeper `>` is the block's text); either also ends with the blockquote or list item
    // holding it.
    if (empty || (table && depth !== table.quote))
      table = undefined
    if (html && ((html.close === null && unquote(line, html.quote).trim() === '') || depth < html.quote || (!empty && indent < html.col)))
      html = undefined
    // A comment opened on an earlier line runs until its closer. An HTML block's also ends with
    // the blockquote or list item holding it: at a line with fewer `>` markers, or one indented
    // less than the item's content column. VitePress 1.6.4's markdown-it ends it at such a line
    // even when it is empty, where GitHub reads on to the `-->`. That line is read in full, as
    // a quoted fence's end is above. A tab in the indent counts in columns (expandTabs), so a
    // tab-indented `<!--` is read as the renderers read it: indented code at the top level, an
    // HTML block in a list item. On the line holding the `-->`, what the comment hid turns into
    // spaces, so the line keeps its indent and stays in the list item holding it.
    let closedHere: typeof comment
    if (comment) {
      if (depth >= comment.quote && indent >= comment.col) {
        const end = visible.indexOf('-->')
        if (end === -1)
          return blank()
        visible = `${' '.repeat(end + 3)}${visible.slice(end + 3)}`
        closedHere = comment
      }
      comment = undefined
    }
    // A `<!--` that is the line's first content, up to three columns past its container's
    // (blockStart, measured on the line as written, tabs expanded), opens an HTML block unless
    // the line heads a table. The block runs to the line holding its `-->`: every comment on such
    // a line is hidden however it is written, and with no `-->` the lines below are too. Anywhere
    // else a comment is inline, and stripInlineComments reads it by VitePress's grammar; one may
    // run on through the later lines of a paragraph, not of a heading or of indented code. The
    // later lines of the paragraph are read only when a comment, a code span, or a link needs them.
    const lead = unquotedLine.trimStart()
    // The container's content column before any list item the line opens: markdown-it tries a
    // table on the whole line before it reads a list item.
    let outer = fences.lists.filter(col => col <= indent).at(-1) ?? 0
    // Whether the line is text of the paragraph above it (`onward`), lazily when quoted less than
    // the paragraph, but never quoted deeper: unless it starts a block that ends the paragraph and
    // a quote alike, a BLOCK_END_RE line, a list item as paragraphAfter reads one, or an HTML
    // block's start, up to three columns past its container or, on a lazy line quoted two or more
    // less than the paragraph, which markdown-it reads without its indent, at any. Such a line, a
    // line indented as code too, keeps the paragraph's quote depth and content column, and a list
    // marker on it is text (`markerText`), opening no list item.
    const item = depth < prevParaQuote || indent < prevParaBase ? LIST_ITEM_RE.test(lead) : INTERRUPTING_ITEM_RE.test(lead)
    const ends = (BLOCK_END_RE.test(lead) || item || htmlBlockAt(lead, false) !== undefined) && (indent - outer <= 3 || depth <= prevParaQuote - 2)
    const onward = prevText && depth <= prevParaQuote && !ends
    const markerText = onward && LIST_ITEM_RE.test(lead)
    // The list items open above end at a line that leaves the quote holding them, or opens a quote
    // left of their content, unless it continues their paragraph lazily.
    if (!(onward && depth < prevParaQuote) && (depth < listsQuote || (depth > listsQuote && indentOf(expandTabs(line)) < (fences.lists.at(-1) ?? 0)))) {
      fences.lists = []
      outer = 0
    }
    const start = markerText ? { lists: fences.lists.filter(col => col <= indent), base: outer, at: indent - outer > 3 ? undefined : indent } : blockStart(fences.lists, unquotedLine)
    const content = start.at === undefined ? undefined : unquotedLine.slice(start.at)
    const paraQuote = onward ? prevParaQuote : depth
    const paraBase = onward ? prevParaBase : start.base
    let spanLines: string[] | undefined
    let commentLines: string[] | undefined
    const spans = (): string[] => (spanLines ??= paragraphAfter(lines, i + 1, paraQuote, paraBase, false))
    const comments = (): string[] => (commentLines ??= paragraphAfter(lines, i + 1, paraQuote, paraBase, true))
    const none = (): string[] => []
    // A table runs on to an empty line, a line of another quote depth or indented less than it or
    // as code, or another block's start (TABLE_END_RE, a comment's, htmlBlockAt), past its
    // delimiter row. It starts at a header row (tableHead), on the whole line or past a list
    // item's marker, but not on a line a code span or a comment from above runs into, nor on a
    // lazy one, quoted less than the paragraph above it. markdown-it tries a table before a
    // deeper quote, so a line quoted deeper than the delimiter row below it heads one at the
    // row's depth, its extra markers in its first cell, unless a deeper quote above runs on into it.
    let tableLine = false
    if (table && !closedHere) {
      if (table.delimiter || !(indent < table.base || indent - table.base > 3 || TABLE_END_RE.test(lead) || lead.startsWith('<!--') || htmlBlockAt(lead, false) !== undefined))
        tableLine = true
      else
        table = undefined
      if (table)
        table.delimiter = false
    }
    if (!tableLine && !html && !closedHere && openTicks === undefined && !(onward && depth < prevParaQuote)) {
      const next = lines[i + 1]
      const level = next === undefined ? depth + 1 : quoteDepth(next)
      const below = next === undefined ? undefined : expandTabs(next.replace(BLOCKQUOTE_RE, ''))
      let base: number | undefined
      if (level === depth)
        base = tableHead(unquotedLine, below, outer) ? outer : content !== undefined && start.base !== outer && tableHead(content, below, start.base) ? start.base : undefined
      else if (level < depth && aboveQuote <= level && tableHead(expandTabs(unquote(line, level)), below, 0))
        base = 0
      if (base !== undefined) {
        table = { quote: level, base, delimiter: true }
        tableLine = true
      }
    }
    // Any other HTML block runs on to its close (htmlBlockAt). One that ends a paragraph starts
    // where any block may; a lone tag's only on a line that continues no paragraph (`onward`).
    let htmlLine = false
    if (html && !tableLine) {
      htmlLine = true
      if (html.close?.test(unquotedLine) === true)
        html = undefined
    }
    else if (!tableLine && !closedHere && openTicks === undefined && content !== undefined && !content.startsWith('<!--')) {
      const close = htmlBlockAt(content, !onward)
      if (close !== undefined) {
        htmlLine = true
        if (close === null || !close.test(content))
          html = { quote: depth, col: start.base, close }
      }
    }
    const htmlBlock = closedHere?.block === true || (!closedHere && !tableLine && content?.startsWith('<!--') === true)
    // The line is HTML, where VitePress reads no code span, no fence, and no heading.
    const asHtml = htmlLine || htmlBlock
    // Whether the line is a paragraph's, whose code spans and comments may run on below it.
    let paragraph = false
    // A table row with its cells' code spans out as well (tableRow).
    let row: string | undefined
    if (htmlBlock) {
      visible = visible.replace(HTML_COMMENT_RE, '')
      if (!closedHere && !content!.includes('-->')) {
        comment = { block: true, quote: depth, col: start.base }
        visible = visible.slice(0, visible.indexOf('<!--'))
      }
    }
    else if (tableLine) {
      const cells = unquote(visible, table?.quote ?? depth)
      const read = tableRow(cells)
      visible = `${visible.slice(0, visible.length - cells.length)}${read.text}`
      row = read.scan
    }
    else {
      // Paragraph text: the rest of a line whose comment closed in a paragraph, a line indented
      // as code that continues the text above it (a deeper quote opens code instead), or a line
      // that ends no paragraph.
      paragraph = !htmlLine && (closedHere !== undefined || (content === undefined ? onward : markerText || !PARAGRAPH_END_RE.test(content)))
      const unquotedVisible = visible.replace(BLOCKQUOTE_RE, '')
      const close = openTicks === undefined ? 0 : runEnd(unquotedVisible, openTicks)
      const past = close === -1 ? visible.length : visible.length - unquotedVisible.length + close
      // A link's destination and title, on this line and on any a title from above wraps onto,
      // hold a `<!--` as text; an HTML block's line holds no link.
      let links: [number, number][] = []
      if (!htmlLine) {
        const tails = linkTails(visible, paragraph ? spans : none)
        const carried = linkCarry.get(i)
        const quoteLength = visible.length - unquotedVisible.length
        links = carried === undefined ? tails.spans : [[quoteLength, quoteLength + carried], ...tails.spans]
        for (const [k, reach] of tails.onward.entries()) {
          if (reach !== undefined)
            linkCarry.set(i + 1 + k, Math.max(linkCarry.get(i + 1 + k) ?? 0, reach))
        }
      }
      const stripped = stripInlineComments(visible, past, paragraph ? spans : none, paragraph ? comments : none, links)
      visible = stripped.text
      if (stripped.open)
        comment = { block: false, quote: 0, col: 0 }
    }
    // NOTE: only FENCED code (``` or ~~~) is exempted from scanning, in a list item too;
    // CommonMark indented (4-space) code blocks are NOT tracked, so author example markup
    // in docs as fenced code, never indented, to keep it out of these checks. A fence opens where
    // the line as written opens one, since the renderers find the blocks before they read a
    // comment: a backtick inside a comment still makes an info string no fence's. A line that
    // starts inside a comment, the rest of a paragraph or an HTML block, opens none, nor does an
    // HTML block's line or a table's. An HTML block's line, as written, may open or end a list
    // item; a table's or a setext underline's may end one, but opens none: a lone `-` below a
    // paragraph's text underlines it. A lazy line, a paragraph's text indented less than the list
    // item it continues, leaves the item open, so a fence below it at the item's indent is the
    // item's.
    const inert = closedHere !== undefined || asHtml || tableLine
    const lazy = paragraph && onward && (markerText || indent < (fences.lists.at(-1) ?? 0))
    const setext = !inert && SETEXT_RE.test(visible) && prevVisible.trim() !== '' && !HEADING_RE.test(prevVisible) && !BLOCK_PREFIX_RE.test(prevVisible)
    if (!lazy)
      listsQuote = depth
    if (tableLine || setext) {
      fences.lists = fences.lists.filter(col => col <= indent)
    }
    else if (asHtml && !closedHere) {
      fences.lists = start.lists
    }
    else if (!lazy && fenceOpens(fences, (inert ? visible : line).replace(BLOCKQUOTE_RE, ''))) {
      if (!inert) {
        fenceQuote = depth
        return blank()
      }
      fences.fence = undefined
    }
    // Tokens inside inline code render literally everywhere — scrub before checking, except
    // for the `raw` entries. Blockquote prefix stripped so a banned token inside a quoted
    // fence is not flagged. A code span can wrap onto the next lines of its paragraph, so
    // only the text between the close of one opened above and the open of one closed below
    // (`from` to `to`) is scanned. A table row's code spans end at its pipes (`row`), and an HTML
    // block's line holds none.
    const unquoted = visible.replace(BLOCKQUOTE_RE, '')
    if (unquoted.trim() === '')
      openTicks = undefined
    let from = 0
    let to = unquoted.length
    if (openTicks !== undefined) {
      const end = runEnd(unquoted, openTicks)
      from = end === -1 ? to : end
      if (end !== -1)
        openTicks = undefined
    }
    // Only a paragraph's backtick run may open a code span that a later line closes: a heading,
    // indented code, or an HTML block's line ends where it stands.
    if (openTicks === undefined && paragraph) {
      const unpaired = unquoted.slice(from).replace(INLINE_CODE_RE, m => ' '.repeat(m.length))
      for (const run of unpaired.matchAll(OPEN_RUN_RE)) {
        if (spans().some(l => runEnd(l, run[0].length) !== -1)) {
          to = from + run.index
          openTicks = run[0].length
          break
        }
      }
    }
    const shown = row ?? (asHtml ? unquoted.slice(from, to).replace(TICK_RE, ' ') : unquoted.slice(from, to))
    const scrubbed = asHtml || row !== undefined ? shown : shown.replace(INLINE_CODE_RE, '')
    for (const { re, msg, raw } of BANNED) {
      if (re.test(raw ? unquoted : scrubbed))
        problems.push(`${where}:${i + 1}  ${msg}\n    ${line.trim()}`)
    }
    // GitHub renders exactly five alert types, uppercase, and nothing after the bracket;
    // Obsidian's other types, its `]+`/`]-` fold markers, and a title after the bracket
    // render as plain quotes there.
    const alert = visible.match(ALERT_RE)
    if (alert && !(ALERT_TYPES.has(alert[1]!) && alert[2]!.trim() === ''))
      problems.push(`${where}:${i + 1}  callout type "[!${alert[1]}]${alert[2]!.trimEnd()}" — use one of the five uppercase GitHub alerts, never foldable or titled (rule 2)\n    ${line.trim()}`)
    // Headings: ATX (# ...) here, or setext (prose line underlined by === / ---). A
    // setext `===` is an H1 and `---` an H2, so a frontmatter block's closing `---`
    // counts as an H2 and cannot double as the page's H1.
    // A line that starts inside a comment, an HTML block's, or a table's is no heading and
    // underlines none.
    const h = inert ? null : visible.match(HEADING_RE)
    if (h) {
      const text = (h[2] ?? '').trim().replace(CLOSING_HASHES_RE, '')
      if (text)
        recordHeading(page, text, h[1]!.length, i + 1)
    }
    else if (setext) {
      recordHeading(page, prevVisible.trim(), visible.trim().startsWith('=') ? 1 : 2, i)
    }
    // The link scan below reads the line with the wrapped code blanked, columns kept.
    const quote = visible.slice(0, visible.length - unquoted.length)
    visibleLines.push(`${quote}${' '.repeat(from)}${shown}`)
    // An HTML block's or a table's line is no text a later line continues or underlines.
    prevVisible = asHtml || tableLine ? '' : visible
    // A run of `=` or of two `-` underlines the text above it, or is text where there is none; one
    // `-` is an empty list item, and three or more a thematic break.
    const underline = content === undefined ? undefined : UNDERLINE_RE.exec(content)?.[1]
    prevText = !asHtml && !tableLine && (content === undefined ? onward : underline === undefined ? markerText || !PARAGRAPH_END_RE.test(content) : !onward && (underline[0] === '=' || underline.length === 2))
    prevParaQuote = paraQuote
    prevParaBase = paraBase
  })

  if (page.h1Line === undefined)
    problems.push(`${where}  no H1 — every page opens with one (rule 5)`)

  // Link targets must resolve. Scan the visible text (fence + comment lines
  // already blanked, wrapped inline code too) line by line with inline code dropped,
  // so links shown as examples are ignored and every problem carries its line. Both
  // inline links and reference definitions are checked, for every relative target —
  // .md, images, and directories alike. A destination that starts on the next line
  // (`[text](` or `[label]:` ending this one) is read from there and reported here. A
  // reference definition is read past the quote and list markers it stands after, with a
  // label that runs on through the next lines of its paragraph; a `[^label]:` one on a public
  // page only (checkLinkTarget's `footnote`).
  const onPublic = where.startsWith(`${PUBLIC_DIR}/`)
  // Line `j` read as the continuation of the line above it: inline code dropped, quote markers off.
  const following = (j: number): string => (visibleLines[j] ?? '').replace(INLINE_CODE_RE, '').replace(BLOCKQUOTE_RE, '')
  visibleLines.forEach((raw, i) => {
    let line = raw.replace(INLINE_CODE_RE, '')
    if (INLINE_DEST_NEXT_RE.test(line)) {
      const next = following(i + 1).trim()
      line = `${line.trimEnd()} ${next.slice(0, next.indexOf(')') + 1)}`
    }
    for (const m of [...line.matchAll(LINK_TARGET_RE), ...line.matchAll(OPEN_TARGET_RE)])
      checkLinkTarget(`${where}:${i + 1}`, file, m[1]!, m[1]!, 'inline')
    let def = raw.replace(INLINE_CODE_RE, '').replace(CONTAINER_PREFIX_RE, '')
    let j = i + 1
    for (; LABEL_OPEN_RE.test(def) && j < visibleLines.length && !PARAGRAPH_END_RE.test(following(j)); j++)
      def = `${def} ${following(j).trim()}`
    if (REF_DEST_NEXT_RE.test(def))
      def = `${def.trimEnd()} ${following(j).trim()}`
    const rm = def.match(REF_DEF_RE)
    if (rm && (onPublic || !rm[1]!.startsWith('^')))
      checkLinkTarget(`${where}:${i + 1}`, file, rm[2]!, rm[0]!.trim(), rm[1]!.startsWith('^') ? 'footnote' : 'ref')
  })
}

for (const w of warns)
  console.warn(`${WARN}docs:portability: ${w}`)
if (problems.length > 0) {
  console.error(`\n✖ docs:portability — ${problems.length} issue(s). Rules: ${RULES_DOC}\n`)
  for (const p of problems)
    console.error(`  ${p}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ docs:portability — ${files.length} files portable across GitHub / VitePress / Obsidian`)
