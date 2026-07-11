import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { searchMemoryFilesUnified } from '../../../server/memory-browser'

export const Route = createFileRoute('/api/memory/search')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        // Agent store first (dashboard files API), local fs fallback —
        // see memory-browser.ts for the unification rules.
        const url = new URL(request.url)
        const query = url.searchParams.get('q') || ''
        try {
          const { results, source } = await searchMemoryFilesUnified(query)
          return json({ results, source })
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to search memory files',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
