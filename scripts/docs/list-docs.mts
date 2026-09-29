/**
 * `pnpm docs:list [decisions|specs]`: prints the decisions table and the spec list, read
 * from the files now. No committed file lists the records, so two branches that each add
 * one touch different files and merge without a conflict; this is the terminal's and an
 * agent's view of the lists, as the sidebar is the handbook's. Read-only; with no argument
 * it prints both. ZERO npm imports, so it runs where the docs toolchain is not installed.
 */
import process from 'node:process'
import { readDecisions, readSpecs, renderDecisionsIndex, renderSpecIndex } from './readers.mts'
import { DECISIONS_DIR, SPECS_DIR } from './root.mts'

const [which, ...rest] = process.argv.slice(2)
if (rest.length > 0 || (which !== undefined && which !== 'decisions' && which !== 'specs')) {
  console.error('usage: pnpm docs:list [decisions|specs]')
  process.exit(1)
}

// The renderers' own placeholders point at `pnpm docs:gen`, which a list read from the
// files never needs.
const sections: string[] = []
if (which !== 'specs') {
  const decisions = readDecisions()
  sections.push(`## Decisions (${DECISIONS_DIR}/, oldest first)`, decisions.length > 0 ? renderDecisionsIndex(decisions) : '_No decisions yet._')
}
if (which !== 'decisions') {
  const specs = readSpecs()
  sections.push(`## Specs (${SPECS_DIR}/)`, specs.length > 0 ? renderSpecIndex(specs) : '_No specs yet._')
}
console.log(sections.join('\n\n'))
