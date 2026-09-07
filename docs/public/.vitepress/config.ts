// PUBLIC SITE — publishable. Keep this site free of anything internal
// (decisions, specs, infra, service topology). Deployment is a per-project
// choice — see docs/template/docs-toolchain.md.
import { defineConfig } from 'vitepress'
import llmstxt from 'vitepress-plugin-llms'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { shared } from '../../.shared/config.ts'

export default withMermaid(defineConfig({
  ...shared,
  description: 'Public documentation.',
  vite: {
    // Emits llms.txt (the "SEO for AI" standard) plus a markdown copy of every page
    // into THIS site's build output (dist), for crawlers and agents on the deployed
    // site. Set `domain` when you deploy so the links are absolute (recipe: AI
    // discoverability in docs/template/docs-toolchain.md).
    // generateLLMsFullTxt is off deliberately: a concatenated corpus is in no version
    // of the llms.txt spec, and v2 is a search-the-map-then-follow-links model.
    // The plugin needs at least one page beside index.md to emit llms.txt at all —
    // that is why getting-started.md must be replaced, never just deleted.
    plugins: [llmstxt({ generateLLMsFullTxt: false })],
  },
}))
