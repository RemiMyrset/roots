// Internal handbook — team audience. If hosted, gate it behind access control
// (recipe: docs/template/docs-toolchain.md). The noindex meta and
// public/robots.txt are belt-and-braces guards against accidental public
// exposure.
import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { decisionsSidebar, specsSidebar } from '../../../scripts/docs/readers.mts'
import { shared, siteName } from '../../.shared/config.ts'

// withMermaid stays with no diagram on the site yet: a future page adds one without a config change.
// The _template.md pages build on purpose: srcExclude would leave the index links dead and fail the build.
export default withMermaid(defineConfig({
  ...shared,
  title: `${siteName} — internal handbook`,
  description: 'Engineering handbook: decisions, specs, guides.',
  head: [
    ['meta', { name: 'robots', content: 'noindex, nofollow' }],
  ],
  themeConfig: {
    nav: [
      { text: 'Handbook', link: '/' },
      { text: 'Decisions', link: '/decisions/' },
      { text: 'Specs', link: '/specs/' },
    ],
    // No guides group: the shared guides live in docs/template/, which is
    // template-owned and deliberately outside this site (read on GitHub). Add a
    // group here when this project writes its own guides (runbooks/, design/).
    sidebar: [
      { text: 'Decisions', link: '/decisions/', items: decisionsSidebar() },
      { text: 'Specs', link: '/specs/', items: specsSidebar() },
    ],
  },
}))
