// Shared VitePress fragment for both sites. Lives OUTSIDE both srcDirs so
// VitePress never scans it as a page. withMermaid() is applied per-site where a
// site wants diagrams — never here (double-wrapping breaks the build).
import type { UserConfig } from 'vitepress'
import pkg from '../../package.json' with { type: 'json' }

/** Site branding for both VitePress sites: the root package.json `name`, so renaming the project is one edit. */
export const siteName: string = pkg.name

/** The repository's web URL from package.json `repository.url` (the `git+` prefix and `.git` suffix dropped), for the site's GitHub link. */
export const repoUrl: string = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')

/**
 * The config fragment both sites spread in: the package name as title, the package
 * description as the head description (search results, social cards, and llms.txt read it),
 * local search, and the GitHub link. No markdown options on purpose: docs are authored to
 * the portable ruleset (docs/template/markdown-portability.md), nothing VitePress-specific.
 */
export const shared: UserConfig = {
  title: siteName,
  description: pkg.description,
  lastUpdated: true,
  themeConfig: {
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: repoUrl }],
  },
}

/**
 * The VitePress `base` for a raw path such as the Pages workflow's `base_path`
 * (`/REPO`, `REPO`, `/`, or empty): `/` when it has no segments, else `/a/b/`.
 * A doubled or missing slash here would land in every asset URL.
 */
export function normalizeBase(raw: string | undefined): string {
  const segments = (raw ?? '').split('/').filter(segment => segment !== '')
  return segments.length === 0 ? '/' : `/${segments.join('/')}/`
}
