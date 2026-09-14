import { createDocsOgImage } from '@/lib/docs-og-image'
import { source } from '@/lib/source'

export const runtime = 'nodejs'

// Static export note: this route used to be an optional catch-all
// (`[[...slug]]`), mirroring each doc page's own multi-segment slug as a
// nested path under `docs/og/`. That breaks Next's static exporter whenever
// one page's slug is a directory-prefix of another's (the docs index at `[]`
// vs. `['activity']`; equally, a section's own landing page at `['odin']`
// vs. its children at `['odin', 'residuals']`) — the exporter needs
// `out/docs/og/<x>` to be a single file for the shorter slug and a directory
// for the longer one at the same time, and fails with EISDIR. Flattening
// every slug to one path segment keeps `docs/og/` a single flat directory,
// so no page's image path can ever collide with another page's directory.
function flattenSlug(slugs: string[]): string {
  return slugs.length > 0 ? slugs.join('-') : 'index'
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({ slug: flattenSlug(page.slugs) }))
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const page = source.getPages().find((p) => flattenSlug(p.slugs) === slug)

  if (!page) {
    return createDocsOgImage({ title: 'Documentation', url: '/docs' })
  }

  return createDocsOgImage({
    title: page.data.title,
    url: page.url
  })
}
