import { createFromSource } from 'fumadocs-core/search/server'
import { source } from '@/lib/source'

// Static export (`output: 'export'`) has no server to answer a live query
// against, so the index is exported once at build time and queried
// client-side (see SearchDialog's `type: 'static'` client).
export const revalidate = false
export const { staticGET: GET } = createFromSource(source)
