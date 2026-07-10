import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { z } from 'zod'

import { dashboardFetch } from '../../server/gateway-capabilities'

const BodySchema = z.object({
  provider: z.string().min(1),
})

function readError(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    if (typeof record.detail === 'string') return record.detail
    if (typeof record.error === 'string') return record.error
    if (typeof record.message === 'string') return record.message
  }
  return fallback
}

// Device-code flows are brokered by the AGENT's dashboard
// (POST /api/providers/oauth/{provider}/start): the dashboard owns the
// provider client_id and spawns its own poller, and we map its response
// onto the device-code shape the settings dialog already consumes —
// `device_code` carries the dashboard session_id, which
// /api/oauth/poll-token forwards to
// /api/providers/oauth/{provider}/poll/{session_id}.
//
// The previous implementation called the Nous portal directly with a
// hardcoded client_id=claude-cli — rejected as invalid_client since the
// Hermes rename — and its raw portal device_code could never match the
// dashboard's poll session registry anyway.
const DEVICE_CODE_PROVIDERS = new Set(['nous'])

export const Route = createFileRoute('/api/oauth/device-code')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return json({ error: 'Invalid JSON' }, { status: 400 })
        }

        const parsed = BodySchema.safeParse(body)
        if (!parsed.success) {
          return json({ error: 'Missing provider' }, { status: 400 })
        }

        const provider = parsed.data.provider.trim()

        if (!DEVICE_CODE_PROVIDERS.has(provider)) {
          return json(
            {
              error: `OAuth device flow not supported for provider: ${provider}`,
            },
            { status: 400 },
          )
        }

        try {
          const res = await dashboardFetch(
            `/api/providers/oauth/${encodeURIComponent(provider)}/start`,
            { method: 'POST' },
          )
          const data: unknown = await res.json().catch(() => ({}))
          if (!res.ok) {
            return json(
              { error: readError(data, 'Device code request failed') },
              { status: res.status },
            )
          }

          const record = (
            data && typeof data === 'object' ? data : {}
          ) as Record<string, unknown>
          const sessionId =
            typeof record.session_id === 'string' ? record.session_id : ''
          if (!sessionId) {
            return json(
              { error: 'Dashboard OAuth start returned no session id' },
              { status: 502 },
            )
          }

          return json({
            device_code: sessionId,
            user_code:
              typeof record.user_code === 'string' ? record.user_code : '',
            verification_uri_complete:
              typeof record.verification_url === 'string'
                ? record.verification_url
                : '',
            expires_in:
              typeof record.expires_in === 'number'
                ? record.expires_in
                : undefined,
            interval:
              typeof record.poll_interval === 'number'
                ? record.poll_interval
                : undefined,
          })
        } catch (err) {
          return json(
            { error: err instanceof Error ? err.message : 'Network error' },
            { status: 500 },
          )
        }
      },
    },
  },
})
