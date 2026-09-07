// Shared VitePress fragment for both sites. Lives OUTSIDE both srcDirs so
// VitePress never scans it as a page. withMermaid() is applied per-site —
// never here (double-wrapping breaks the build).
import type { UserConfig } from 'vitepress'
import pkg from '../../package.json' with { type: 'json' }

/** Site branding for both VitePress sites: the root package.json `name`, so renaming the project is one edit. */
export const siteName: string = pkg.name

/**
 * The config fragment both sites spread in. No markdown options on purpose: docs are
 * authored to the portable ruleset (docs/template/markdown-portability.md), nothing
 * VitePress-specific.
 */
export const shared: UserConfig = {
  title: siteName,
  lastUpdated: true,
}
