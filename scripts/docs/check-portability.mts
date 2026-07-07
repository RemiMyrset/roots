/**
 * Portability guard: every markdown doc must render acceptably in GitHub,
 * VitePress, AND Obsidian. Blocking. A lint, not a build.
 *
 * The full human-readable ruleset lives in
 * docs/internal/development/markdown-portability.md — error messages cite it.
 * Scope: docs/** plus root README.md and AGENTS.md. Never .claude/ or .github/
 * (their files require YAML frontmatter, which is banned in docs/).
 *
 * Adapted from an earlier internal docs-portability checker.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { repoRoot } from './generators.mts'

const RULES_DOC = 'docs/internal/development/markdown-portability.md'
const SKIP_DIRS = new Set(['.vitepress', '.obsidian', 'node_modules', 'dist'])

const BANNED: { re: RegExp, msg: string }[] = [
  { re: /\[\[/, msg: 'Obsidian wikilink "[[" — use a relative [text](./file.md) link (rule 1)' },
  // NB: @include is NOT here — it lives inside an HTML comment, which the loop
  // strips before the BANNED scan, so it is checked separately (see below).
  { re: /^\s*<<</, msg: 'VitePress code snippet "<<<" — paste the snippet or link the source (rule 10)' },
  { re: /^\s*:::/, msg: 'VitePress container ":::" — use a GitHub-style "> [!NOTE]" alert (rule 2)' },
  { re: /\]\(\/[^)]/, msg: 'absolute link "](/...)" — use a relative path (rule 1)' },
  // Lookarounds keep prose like `docs:internal:dev` or 12:30:45 from matching:
  // a real shortcode is not adjacent to another word/colon segment.
  { re: /(?<![\w:]):[a-z0-9_+-]+:(?![\w:])/, msg: 'emoji shortcode — use the real Unicode character (rule 8)' },
  { re: /\{\{/, msg: 'Vue interpolation "{{" — VitePress compiles every page as a Vue template, so "{{ ... }}" is evaluated and silently dropped (rule 9)' },
  { re: /<\/?(?!(?:details|summary|br)\b)[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>/i, msg: 'raw HTML tag beyond <details>/<summary>/<br> — renders inconsistently across GitHub / VitePress / Obsidian (rule 9)' },
]

const OPEN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const CLOSE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/
const SETEXT_RE = /^ {0,3}(?:=+|-+)\s*$/
// Leading blockquote markers, stripped before fence/BANNED scans so a fenced code
// block inside a `> [!NOTE]` alert (`> ```yaml`) is recognized as code, not scanned.
const BLOCKQUOTE_RE = /^ {0,3}(?:> ?)+/
// A block-level previous line (blockquote/list) turns a following `---`/`===` into a
// thematic break, not a setext heading underline.
const BLOCK_PREFIX_RE = /^ {0,3}(?:>|[-*+] |\d+[.)] )/
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
// Backtick runs must match in length (CommonMark), so ``a `b` c`` parses as one
// span. The body is [^\n]+? (min 1, single line): bounding it to one line stops
// a stray backtick from pairing with a distant one across the joined document
// and blanking every real link in between. A zero-length body could never
// satisfy the trailing (?<!`) anyway, since the char before it is the opener.
const INLINE_CODE_RE = /(?<!`)(`+)(?!`)[^\n]+?(?<!`)\1(?!`)/g
const HEADING_RE = /^#{1,6}\s+(\S.*)$/
const HEADING_BACKTICK_RE = /`/
const NON_ASCII_RE = /[^\x20-\x7E]/
const LINK_TARGET_RE = /\]\(([^)\n]+)\)/g
const REF_DEF_RE = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(\S+)/
const LINK_TITLE_RE = /\s+("[^"]*"|'[^']*')$/
const NON_FILE_TARGET_RE = /^(?:https?:|mailto:|#)/

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
const files = [join(root, 'README.md'), join(root, 'AGENTS.md'), ...walk(join(root, 'docs'))]
  .filter(f => existsSync(f) && statSync(f).isFile())

const problems: string[] = []
const warns: string[] = []

interface HeadingHit { line: number, text: string }

function recordHeading(headings: Map<string, HeadingHit>, where: string, headingText: string, lineNo: number): void {
  const key = headingText.toLowerCase()
  const prev = headings.get(key)
  if (prev !== undefined)
    problems.push(`${where}:${lineNo}  duplicate heading "${headingText}" (also line ${prev.line}) — slug dedupe differs per renderer (rule 5)`)
  else
    headings.set(key, { line: lineNo, text: headingText })
  if (HEADING_BACKTICK_RE.test(headingText) || NON_ASCII_RE.test(headingText))
    warns.push(`${where}:${lineNo}  heading with backticks or non-ASCII — slug algorithms diverge (rule 5)`)
}

function checkLinkTarget(where: string, file: string, raw: string, display: string, kind: 'inline' | 'ref'): void {
  // Normalize CommonMark link forms: optional title (./a.md "t") and angle
  // brackets (<./a b.md>).
  let target = raw.trim().replace(LINK_TITLE_RE, '')
  if (target.startsWith('<') && target.endsWith('>'))
    target = target.slice(1, -1)
  if (NON_FILE_TARGET_RE.test(target))
    return
  const rel = target.split('#')[0]!
  if (!rel)
    return
  if (rel.startsWith('/')) {
    // Inline absolute links "](/path)" are already reported by the BANNED scan,
    // but its regex needs a char after the slash, so the bare root link "](/)"
    // slips past it — flag that here. Reference definitions are never covered by
    // the BANNED scan, so flag those too.
    if (kind === 'ref')
      problems.push(`${where}  absolute link "${display}" — use a relative path (rule 1)`)
    else if (target === '/')
      problems.push(`${where}  root-absolute inline link "${display}" — use a relative path (rule 1)`)
    return
  }
  if (!existsSync(resolve(dirname(file), rel)))
    problems.push(`${where}  broken relative link: ${display}`)
}

for (const file of files) {
  const where = relative(root, file)
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')

  if (lines[0]?.trim() === '---')
    problems.push(`${where}:1  YAML frontmatter — metadata goes in visible bold bullets (rule 3)`)

  // Track fenced blocks and multi-line HTML comments, and keep the rendered
  // ("visible") text of every line so link scanning below sees exactly what a
  // reader would — fence content and comments blanked, inline code preserved
  // for now.
  let fence: { char: string, len: number, bq: boolean } | null = null
  let inComment = false
  let prevVisible = ''
  const visibleLines: string[] = []
  const headings = new Map<string, HeadingHit>()

  lines.forEach((line, i) => {
    // Inside a fence nothing renders as markup. Only a fence of the SAME
    // character and AT LEAST the opener's length closes it (CommonMark).
    if (fence) {
      // A fence opened inside a blockquote cannot outlive the quote (CommonMark): if the quote
      // has ended — this line carries no `>` marker (blank or plain prose) — close the fence and
      // fall through to scan this line normally, instead of latching fence-state to EOF.
      if (!(fence.bq && !BLOCKQUOTE_RE.test(line))) {
        // Only a blockquoted fence's close carries a `>` prefix; strip it just for that case so
        // a plain fence whose body contains a literal `> ```` line is not closed early.
        const close = (fence.bq ? line.replace(BLOCKQUOTE_RE, '') : line).match(CLOSE_FENCE_RE)
        if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len)
          fence = null
        visibleLines.push('')
        prevVisible = ''
        return
      }
      fence = null
    }
    // A comment opened on an earlier line runs until its closer.
    let visible = line
    if (inComment) {
      const end = visible.indexOf('-->')
      if (end === -1) {
        visibleLines.push('')
        prevVisible = ''
        return
      }
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
    // NOTE: only FENCED code (``` or ~~~) is exempted from scanning; CommonMark
    // indented (4-space) code blocks are NOT tracked, so author example markup
    // in docs as fenced code, never indented, to keep it out of these checks.
    const open = visible.replace(BLOCKQUOTE_RE, '').match(OPEN_FENCE_RE)
    if (open) {
      fence = { char: open[1]![0]!, len: open[1]!.length, bq: BLOCKQUOTE_RE.test(visible) }
      visibleLines.push('')
      prevVisible = ''
      return
    }
    // Tokens inside inline code render literally everywhere — scrub before checking.
    // Blockquote prefix stripped so a banned token inside a quoted fence is not flagged.
    const scrubbed = visible.replace(BLOCKQUOTE_RE, '').replace(INLINE_CODE_RE, '')
    for (const { re, msg } of BANNED) {
      if (re.test(scrubbed))
        problems.push(`${where}:${i + 1}  ${msg}\n    ${line.trim()}`)
    }
    // Headings: ATX (# ...) here, or setext (prose line underlined by === / ---).
    const h = visible.match(HEADING_RE)
    if (h) {
      recordHeading(headings, where, h[1]!.trim(), i + 1)
    }
    else if (SETEXT_RE.test(visible) && prevVisible.trim() !== '' && !HEADING_RE.test(prevVisible) && !BLOCK_PREFIX_RE.test(prevVisible)) {
      recordHeading(headings, where, prevVisible.trim(), i)
    }
    visibleLines.push(visible)
    prevVisible = visible
  })

  // Link targets must resolve. Scan the visible text (fence + comment lines
  // already blanked) with inline code dropped, so links shown as examples are
  // ignored. Both inline links and reference definitions are checked, for every
  // relative target — .md, images, and directories alike.
  const noCode = visibleLines.join('\n').replace(INLINE_CODE_RE, '')
  for (const m of noCode.matchAll(LINK_TARGET_RE))
    checkLinkTarget(where, file, m[1]!, m[1]!, 'inline')
  for (const line of noCode.split('\n')) {
    const rm = line.match(REF_DEF_RE)
    if (rm)
      checkLinkTarget(where, file, rm[1]!, rm[0]!.trim(), 'ref')
  }
}

for (const w of warns)
  console.warn(`::warning::docs:portability: ${w}`)
if (problems.length > 0) {
  console.error(`\n✖ docs:portability — ${problems.length} issue(s). Rules: ${RULES_DOC}\n`)
  for (const p of problems)
    console.error(`  ${p}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ docs:portability — ${files.length} files portable across GitHub / VitePress / Obsidian`)
