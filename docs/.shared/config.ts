// Shared VitePress fragment for both sites. Lives OUTSIDE both srcDirs so
// VitePress never scans it as a page. withMermaid() is applied per-site —
// never here (double-wrapping breaks the build).
import type { UserConfig } from 'vitepress'

export const shared: UserConfig = {
  title: 'roots',
  lastUpdated: true,
  markdown: {
    // Docs are authored to the portable ruleset
    // (docs/internal/development/markdown-portability.md); nothing
    // VitePress-specific is enabled on purpose.
  },
}
