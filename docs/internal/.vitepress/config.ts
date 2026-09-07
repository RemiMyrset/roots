// Internal handbook — team audience. If hosted, gate it behind access control
// (recipe: docs/template/docs-toolchain.md). The noindex meta and
// public/robots.txt are belt-and-braces guards against accidental public
// exposure.
import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { decisionsSidebar, specsSidebar } from '../../../scripts/docs/generators.mts'
import { shared, siteName } from '../../.shared/config.ts'

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
    // No Development group: the shared guides live in docs/template/, which is
    // template-owned and deliberately outside this site (read on GitHub). Add a
    // group here when this project writes its own guides under development/.
    sidebar: [
      { text: 'Decisions', link: '/decisions/', items: decisionsSidebar() },
      { text: 'Specs', link: '/specs/', items: specsSidebar() },
    ],
  },
}))
