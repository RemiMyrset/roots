/**
 * automd generators for the two index lists, thin wrappers over the renderers in
 * readers.mts. The regions are opt-in: a list committed into a page conflicts whenever two
 * branches each add a record, so the sidebar and `pnpm docs:list` read the lists from the
 * files instead. The generators stay for a page that keeps its region, and so a child's
 * automd.config.ts that imports them still resolves; a merge conflict inside a region is
 * fixed by `pnpm docs:gen`, which rewrites the whole region. This is the ONE docs script
 * that imports automd — keep root.mts, readers.mts, skills.mts, and the checkers free of npm
 * imports (the pre-commit hook runs them without the docs toolchain installed). The readers
 * and sidebars are re-exported so a site config or generator written against this module
 * keeps working.
 */
import { defineGenerator } from 'automd'
import { readDecisions, readSpecs, renderDecisionsIndex, renderSpecIndex } from './readers.mts'

export * from './readers.mts'

/** The decisions table for a page that keeps a `<!-- automd:decisionsIndex -->` region; opt-in. Never hand-edit the region. */
export const decisionsIndex = defineGenerator({
  name: 'decisionsIndex',
  generate() {
    return { contents: renderDecisionsIndex(readDecisions()) }
  },
})

/** The area-grouped spec list for a page that keeps a `<!-- automd:specIndex -->` region; opt-in. Never hand-edit the region. */
export const specIndex = defineGenerator({
  name: 'specIndex',
  generate() {
    return { contents: renderSpecIndex(readSpecs()) }
  },
})
