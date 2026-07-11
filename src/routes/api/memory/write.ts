import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { writeMemoryFileUnified } from '../../../server/memory-browser'
import { requireJsonContentType } from '../../../server/rate-limit'

export const Route = createFileRoute('/api/memory/write')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck
        // Writes land in the AGENT's store while it is reachable (dashboard
        // files API — one source of truth for both UIs); local fs only when
        // the dashboard is down. An agent-side failure is surfaced, never
        // silently redirected to a local file (that would fork the memory).
        try {
          const body = (await request.json().catch(() => ({}))) as {
            path?: unknown
            content?: unknown
          }
          if (typeof body.path !== 'string') {
            return json({ error: 'Path is required' }, { status: 400 })
          }
          const content = typeof body.content === 'string' ? body.content : ''
          const { source, path: relativePath } = await writeMemoryFileUnified(
            body.path,
            content,
          )
          return json({ success: true, path: relativePath, source })
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : 'Failed to write memory file'
          const status =
            /required|absolute|traversal|outside workspace|Markdown|\.md/i.test(
              message,
            )
              ? 400
              : /write failed/i.test(message)
                ? 502
                : 500
          return json({ error: message }, { status })
        }
      },
    },
  },
})
