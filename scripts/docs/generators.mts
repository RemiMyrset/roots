/**
 * automd generators for the two index pages, thin wrappers over the renderers in
 * readers.mts. This is the ONE docs script that imports automd — keep root.mts, readers.mts,
 * skills.mts, and the checkers free of npm imports (the pre-commit hook runs them without
 * the docs toolchain installed). The readers and sidebars are re-exported so a site config
 * or generator written against this module keeps working.
 */
import { defineGenerator } from 'automd'
import { readDecisions, readSpecs, renderDecisionsIndex, renderSpecIndex } from './readers.mts'

export * from './readers.mts'

/** Generated table for docs/internal/decisions/index.md. Never hand-edit. */
export const decisionsIndex = defineGenerator({
  name: 'decisionsIndex',
  generate() {
    return { contents: renderDecisionsIndex(readDecisions()) }
  },
})

/** Generated area-grouped list for docs/internal/specs/index.md. Never hand-edit. */
export const specIndex = defineGenerator({
  name: 'specIndex',
  generate() {
    return { contents: renderSpecIndex(readSpecs()) }
  },
})
