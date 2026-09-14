import type { MetadataRoute } from 'next'
import { source } from '@/lib/source'

// Required for `output: 'export'`: a route with no static params must be
// pinned static explicitly, since Next can no longer regenerate it on demand.
export const revalidate = false

const siteUrl = 'https://odin.unempyd.com'

export default function sitemap(): MetadataRoute.Sitemap {
  return source.getPages().map((page) => ({
    url: `${siteUrl}${page.url}`,
    lastModified: new Date(),
    changeFrequency: 'weekly',
    priority: page.url === '/docs' ? 0.9 : 0.7
  }))
}
