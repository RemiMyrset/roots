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
 * docs/public links and embeds nothing outside it, and no symlink there leads out, since the
 * build follows symlinks; a page has exactly one H1; a callout is one of the five uppercase GitHub alerts,
 * unfolded and untitled; and an index page is named for where it lives (rule 6). Fenced code
 * is skipped, at the top level, in a list item, and in a blockquote; so is inline code, on
 * every line of its paragraph it spans. A link destination may start on the next line.
 *
 * Adapted from an earlier internal docs-portability checker.
 */
import type { FenceState } from './root.mts'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { ATX_HEADING_RE, CLOSING_HASHES_RE, fenceContinues, fenceOpens, githubSlug, pathCase, repoRoot, SKIP_DIRS, slugsOf, WARN } from './root.mts'
import { posixRelative } from './skills.mts'

const RULES_DOC = 'docs/template/markdown-portability.md'

// `raw` entries are tested before inline code is scrubbed: the token is live even there.
const BANNED: { re: RegExp, msg: string, raw?: true }[] = [
  { re: /\[\[/, msg: 'Obsidian wikilink "[[" — use a relative [text](./file.md) link (rule 1)' },
  // NB: @include is NOT here — it lives inside an HTML comment, which the loop
  // strips before the BANNED scan, so it is checked separately (see below).
  { re: /^\s*<<</, msg: 'VitePress code snippet "<<<" — paste the snippet or link the source (rule 10)' },
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
// Leading blockquote markers, stripped before fence/BANNED scans so a fenced code
// block inside a `> [!NOTE]` alert (`> ```yaml`) is recognized as code, not scanned.
const BLOCKQUOTE_RE = /^ {0,3}(?:> ?)+/
// A block-level previous line (blockquote/list) turns a following `---`/`===` into a
// thematic break, not a setext heading underline.
const BLOCK_PREFIX_RE = /^ {0,3}(?:>|[-*+] |\d+[.)] )/
// A callout opener: the type inside `> [!TYPE]` is group 1; the rest of the line (Obsidian's
// fold marker or a title) is group 2. Matched with the blockquote prefix in place so a
// backticked example (`> `[!tip]``) is not one.
const ALERT_RE = /^ {0,3}(?:> ?)+\[!([^\]\n]*)\](.*)$/
const ALERT_TYPES: ReadonlySet<string> = new Set(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'])
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
// Line endings are normalized on read, so a CRLF file (written on Windows before git
// normalizes it) reads as the LF checkout will: the heading grammar ends in `$`.
const CRLF_RE = /\r\n/g
// Backtick runs must match in length (CommonMark), so ``a `b` c`` parses as one
// span. The body is [^\n]+? (min 1, single line): bounding it to one line stops
// a stray backtick from pairing with a distant one across the joined document
// and blanking every real link in between. A zero-length body could never
// satisfy the trailing (?<!`) anyway, since the char before it is the opener.
const INLINE_CODE_RE = /(?<!`)(`+)(?!`)[^\n]+?(?<!`)\1(?!`)/g
// A backtick run left unpaired on its line: it opens a code span only when a later line of the
// paragraph holds a run of the same length (CommonMark), else it is a literal backtick.
const TICK_RUN_RE = /`+/g
// A line that ends a paragraph, and any code span still open in it: blank, an ATX heading, or a
// fence.
const PARAGRAPH_END_RE = /^\s*$|^ {0,3}(?:#{1,6}(?:\s|$)|`{3,}|~{3,})/
// The heading grammar is root.mts's ATX_HEADING_RE, shared with the anchor checker, so an
// indented heading or a closing hash run reads the same on both sides.
const HEADING_RE = ATX_HEADING_RE
const HEADING_BACKTICK_RE = /`/
const NON_ASCII_RE = /[^\x20-\x7E]/
const LINK_TARGET_RE = /\]\(([^)\n]+)\)/g
const REF_DEF_RE = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(\S+)/
// A line ending before its link destination, which CommonMark lets start on the next line.
const INLINE_DEST_NEXT_RE = /\]\(\s*$/
const REF_DEST_NEXT_RE = /^ {0,3}\[(?!\^)[^\]]+\]:\s*$/
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

/** Whether a line of the paragraph from `lines[from]` on holds a run of exactly `len` backticks, closing a code span opened above it. */
function closesLater(lines: string[], from: number, len: number): boolean {
  for (const line of lines.slice(from)) {
    const unquoted = line.replace(BLOCKQUOTE_RE, '')
    if (PARAGRAPH_END_RE.test(unquoted))
      return false
    if (runEnd(unquoted, len) !== -1)
      return true
  }
  return false
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

function checkLinkTarget(where: string, file: string, raw: string, display: string, kind: 'inline' | 'ref'): void {
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
  // A target is a URL path: "My%20Doc.md" names "My Doc.md" (Obsidian writes pasted image links
  // this way). A malformed escape is checked as written.
  let path = rel
  try {
    path = decodeURIComponent(rel)
  }
  catch {}
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
      problems.push(`${where}  link or image outside ${PUBLIC_DIR}: ${display} — the public site would publish it; copy the file into ${PUBLIC_DIR} or link it by URL (rule 4)`)
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

  // Track fenced blocks and multi-line HTML comments, and keep the rendered
  // ("visible") text of every line so link scanning below sees exactly what a
  // reader would — fence content and comments blanked, inline code preserved
  // for now.
  const fences: FenceState = { lists: [] }
  let quotedFence = false
  let inComment = false
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
  }

  lines.forEach((line, i) => {
    // Inside a fence nothing renders as markup. Only a fence of the SAME
    // character and AT LEAST the opener's length closes it (CommonMark).
    if (fences.fence) {
      // A fence opened inside a blockquote cannot outlive the quote (CommonMark): if the quote
      // has ended — this line carries no `>` marker (blank or plain prose) — close the fence and
      // fall through to scan this line normally, instead of latching fence-state to EOF. A
      // fence in a list item ends with the item the same way (fenceContinues).
      // Only a blockquoted fence's lines carry a `>` prefix; strip it just for that case so
      // a plain fence whose body contains a literal `> ```` line is not closed early.
      if (quotedFence && !BLOCKQUOTE_RE.test(line))
        fences.fence = undefined
      else if (fenceContinues(fences, quotedFence ? line.replace(BLOCKQUOTE_RE, '') : line))
        return blank()
    }
    // A comment opened on an earlier line runs until its closer.
    let visible = line
    if (inComment) {
      const end = visible.indexOf('-->')
      if (end === -1)
        return blank()
      visible = visible.slice(end + 3)
      inComment = false
    }
    // @include lives inside an HTML comment, which the strip below removes — so
    // test for it on the raw (pre-strip) line, inline code masked so a backticked
    // example is not flagged. Fenced/comment-continuation lines already returned.
    // Single-line assumption: a rare multi-line `<!--\n@include ...\n-->` is not
    // caught (VitePress-only cosmetic break, not a portability crash).
    if (/<!--\s*@include/i.test(visible.replace(INLINE_CODE_RE, m => ' '.repeat(m.length))))
      problems.push(`${where}:${i + 1}  VitePress @include — single-source via automd instead (rule 10)\n    ${line.trim()}`)
    // Strip complete inline comments, then look for an unclosed opener on a copy
    // with inline code masked (index-preserving), so a backticked `<!--` cannot
    // switch the scanner into comment mode for the rest of the file.
    visible = visible.replace(HTML_COMMENT_RE, '')
    const commentStart = visible.replace(INLINE_CODE_RE, m => ' '.repeat(m.length)).indexOf('<!--')
    if (commentStart !== -1) {
      visible = visible.slice(0, commentStart)
      inComment = true
    }
    // NOTE: only FENCED code (``` or ~~~) is exempted from scanning, in a list item too;
    // CommonMark indented (4-space) code blocks are NOT tracked, so author example markup
    // in docs as fenced code, never indented, to keep it out of these checks.
    if (fenceOpens(fences, visible.replace(BLOCKQUOTE_RE, ''))) {
      quotedFence = BLOCKQUOTE_RE.test(visible)
      return blank()
    }
    // Tokens inside inline code render literally everywhere — scrub before checking, except
    // for the `raw` entries. Blockquote prefix stripped so a banned token inside a quoted
    // fence is not flagged. A code span can wrap onto the next lines of its paragraph, so
    // only the text between the close of one opened above and the open of one closed below
    // (`from` to `to`) is scanned.
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
    if (openTicks === undefined) {
      const unpaired = unquoted.slice(from).replace(INLINE_CODE_RE, m => ' '.repeat(m.length))
      for (const run of unpaired.matchAll(TICK_RUN_RE)) {
        if (closesLater(lines, i + 1, run[0].length)) {
          to = from + run.index
          openTicks = run[0].length
          break
        }
      }
    }
    const scrubbed = unquoted.slice(from, to).replace(INLINE_CODE_RE, '')
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
    const h = visible.match(HEADING_RE)
    if (h) {
      const text = (h[2] ?? '').trim().replace(CLOSING_HASHES_RE, '')
      if (text)
        recordHeading(page, text, h[1]!.length, i + 1)
    }
    else if (SETEXT_RE.test(visible) && prevVisible.trim() !== '' && !HEADING_RE.test(prevVisible) && !BLOCK_PREFIX_RE.test(prevVisible)) {
      recordHeading(page, prevVisible.trim(), visible.trim().startsWith('=') ? 1 : 2, i)
    }
    // The link scan below reads the line with the wrapped code blanked, columns kept.
    const quote = visible.slice(0, visible.length - unquoted.length)
    visibleLines.push(`${quote}${' '.repeat(from)}${unquoted.slice(from, to)}`)
    prevVisible = visible
  })

  if (page.h1Line === undefined)
    problems.push(`${where}  no H1 — every page opens with one (rule 5)`)

  // Link targets must resolve. Scan the visible text (fence + comment lines
  // already blanked, wrapped inline code too) line by line with inline code dropped,
  // so links shown as examples are ignored and every problem carries its line. Both
  // inline links and reference definitions are checked, for every relative target —
  // .md, images, and directories alike. A destination that starts on the next line
  // (`[text](` or `[label]:` ending this one) is read from there and reported here.
  visibleLines.forEach((raw, i) => {
    let line = raw.replace(INLINE_CODE_RE, '')
    const inlineNext = INLINE_DEST_NEXT_RE.test(line)
    if (inlineNext || REF_DEST_NEXT_RE.test(line)) {
      const next = (visibleLines[i + 1] ?? '').replace(INLINE_CODE_RE, '').replace(BLOCKQUOTE_RE, '').trim()
      line = `${line.trimEnd()} ${inlineNext ? next.slice(0, next.indexOf(')') + 1) : next}`
    }
    for (const m of line.matchAll(LINK_TARGET_RE))
      checkLinkTarget(`${where}:${i + 1}`, file, m[1]!, m[1]!, 'inline')
    const rm = line.match(REF_DEF_RE)
    if (rm)
      checkLinkTarget(`${where}:${i + 1}`, file, rm[1]!, rm[0]!.trim(), 'ref')
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
