import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { listMemoryFilesUnified } from '../../../server/memory-browser'

export const Route = createFileRoute('/api/memory/list')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        // Memory prefers the AGENT's store: the agent keeps MEMORY.md/USER.md
        // under ITS home (dashboard files API), not under the workspace's
        // $HERMES_HOME — on split deployments the local dir is empty while the
        // agent has content. Local fs is the fallback when the dashboard is
        // unreachable; `source` tells the UI which store answered.
        try {
          const { files, source } = await listMemoryFilesUnified()
          return json({ files, source })
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to list memory files',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
