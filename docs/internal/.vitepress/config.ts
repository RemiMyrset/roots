// Internal handbook — team audience. If hosted, gate it behind access control
// (recipe: docs/internal/development/docs-toolchain.md). The noindex meta and
// public/robots.txt are belt-and-braces guards against accidental public
// exposure.
import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { decisionsSidebar, specsSidebar } from '../../../scripts/docs/generators.mts'
import { shared } from '../../.shared/config.ts'

export default withMermaid(defineConfig({
  ...shared,
  title: 'roots — internal handbook',
  description: 'Engineering handbook: decisions, specs, development guides.',
  head: [
    ['meta', { name: 'robots', content: 'noindex, nofollow' }],
  ],
  themeConfig: {
    nav: [
      { text: 'Handbook', link: '/' },
      { text: 'Decisions', link: '/decisions/' },
      { text: 'Specs', link: '/specs/' },
    ],
    sidebar: [
      {
        text: 'Development',
        items: [
          { text: 'Spec discipline', link: '/development/spec-discipline' },
          { text: 'Markdown portability', link: '/development/markdown-portability' },
          { text: 'Docs toolchain', link: '/development/docs-toolchain' },
        ],
      },
      { text: 'Decisions', link: '/decisions/', items: decisionsSidebar() },
      { text: 'Specs', link: '/specs/', items: specsSidebar() },
    ],
  },
}))
