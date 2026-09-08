// PUBLIC SITE — publishable. Keep this site free of anything internal
// (decisions, specs, infra, service topology). Published by the GitHub Pages
// workflow (.github/workflows/pages.yml) — recipe: docs/template/docs-toolchain.md,
// "Publish the public site".
import process from 'node:process'
import { defineConfig } from 'vitepress'
import llmstxt from 'vitepress-plugin-llms'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { shared } from '../../.shared/config.ts'

// Both come from the Pages workflow (actions/configure-pages): DOCS_BASE is the
// project-site path (`/REPO/`, or `/` for a user site or custom domain), DOCS_URL
// the absolute origin plus base. Unset in local and unpublished builds, so links
// stay relative and no sitemap hostname is invented. The llms plugin prepends
// `base` itself, so it gets the origin only; the sitemap does not, so it gets
// the full URL.
const base = process.env.DOCS_BASE || '/'
const url = process.env.DOCS_URL ? `${process.env.DOCS_URL.replace(/\/+$/, '')}/` : undefined
const origin = url ? new URL(url).origin : undefined

export default withMermaid(defineConfig({
  ...shared,
  description: 'Public documentation.',
  base,
  ...(url ? { sitemap: { hostname: url } } : {}),
  vite: {
    // Emits llms.txt (the "SEO for AI" standard) plus a markdown copy of every page
    // but the index into THIS site's build output (dist), for crawlers and agents on
    // the deployed site; `domain` makes its links absolute once the workflow supplies
    // the URL.
    // generateLLMsFullTxt is off deliberately: a concatenated corpus is in no version
    // of the llms.txt spec, and v2 is a search-the-map-then-follow-links model.
    // The plugin needs at least one page beside index.md to emit llms.txt at all —
    // that is why getting-started.md must be replaced, never just deleted.
    plugins: [llmstxt({ generateLLMsFullTxt: false, ...(origin ? { domain: origin } : {}) })],
  },
}))
