// Shared VitePress fragment for both sites. Lives OUTSIDE both srcDirs so
// VitePress never scans it as a page. withMermaid() is applied per-site —
// never here (double-wrapping breaks the build).
import type { UserConfig } from 'vitepress'

// No markdown options on purpose: docs are authored to the portable ruleset
// (docs/template/markdown-portability.md), nothing VitePress-specific.
export const shared: UserConfig = {
  title: 'roots',
  lastUpdated: true,
}
