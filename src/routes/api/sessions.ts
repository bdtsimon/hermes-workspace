import { randomUUID } from 'node:crypto'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import {
  SESSIONS_API_UNAVAILABLE_MESSAGE,
  createSession,
  deleteSession,
  ensureGatewayProbed,
  getGatewayCapabilities,
  listSessions,
  toSessionSummary,
  updateSession,
} from '../../server/claude-api'
import { createCapabilityUnavailablePayload } from '@/lib/feature-gates'
import {
  deleteLocalSession,
  getLocalSession,
  listLocalSessions,
  updateLocalSessionTitle,
} from '../../server/local-session-store'
import { dashboardFetch } from '../../server/gateway-capabilities'

const WORKSPACE_CONTEXT_TAG_RE = /\s*<workspace_context\b[^>]*\/?>\s*/gi

// Strip-and-keep: remove the workspace_context tag wherever it sits (prefix
// era or the current suffix placement) and keep the surrounding user text —
// rejecting the whole string blanked titles/previews for every session that
// ever carried the tag.
function cleanSessionDisplayText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (!/<workspace_context\b/i.test(trimmed)) return trimmed
  const cleaned = trimmed.replace(WORKSPACE_CONTEXT_TAG_RE, '\n').trim()
  return cleaned || undefined
}

function cleanGatewaySessionSummary<T extends Record<string, unknown>>(session: T): T {
  const cleanLabel = cleanSessionDisplayText(session.label)
  const cleanTitle = cleanSessionDisplayText(session.title)
  const cleanDerivedTitle = cleanSessionDisplayText(session.derivedTitle)
  const cleanPreview = cleanSessionDisplayText(session.preview)

  const fallbackId =
    cleanSessionDisplayText(session.friendlyId) ||
    cleanSessionDisplayText(session.key) ||
    cleanSessionDisplayText(session.id) ||
    'Session'

  return {
    ...session,
    label: cleanLabel,
    title: cleanTitle,
    derivedTitle: cleanDerivedTitle || cleanTitle || cleanLabel || fallbackId,
    preview: cleanPreview ?? null,
  }
}

export const Route = createFileRoute('/api/sessions')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Auth check
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const capabilities = await ensureGatewayProbed()
        if (!capabilities.sessions) {
          return json({
            ok: true,
            sessions: [],
            source: 'unavailable',
            message: SESSIONS_API_UNAVAILABLE_MESSAGE,
          })
        }

        try {
          const sessions = await listSessions(50, 0)
          const gatewaySessions = sessions.map(toSessionSummary).map(cleanGatewaySessionSummary)

          // Merge local portable sessions (Ollama, Atomic Chat, etc.)
          const localSessions = listLocalSessions()
          const gatewayIds = new Set(gatewaySessions.map((s: any) => s.key || s.id))
          for (const ls of localSessions) {
            if (!gatewayIds.has(ls.id)) {
              gatewaySessions.push({
                key: ls.id,
                id: ls.id,
                friendlyId: ls.id,
                title: ls.title || 'Local Chat',
                label: ls.title || 'Local Chat',
                derivedTitle: ls.title || 'Local Chat',
                startedAt: ls.createdAt,
                updatedAt: ls.updatedAt,
                message_count: ls.messageCount,
                model: ls.model,
                source: 'local',
              } as any)
            }
          }

          return json({ sessions: gatewaySessions })
        } catch (err) {
          return json(
            {
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheckPost = requireJsonContentType(request)
        if (csrfCheckPost) return csrfCheckPost
        const capabilities = await ensureGatewayProbed()
        if (!capabilities.sessions) {
          const friendlyId = randomUUID()
          return json({
            ...createCapabilityUnavailablePayload('sessions'),
            ok: true,
            sessionKey: friendlyId,
            friendlyId,
            persisted: false,
          })
        }
        try {
          const body = (await request.json().catch(() => ({}))) as Record<
            string,
            unknown
          >

          const requestedLabel =
            typeof body.label === 'string' ? body.label.trim() : ''
          const label = requestedLabel || undefined

          const requestedFriendlyId =
            typeof body.friendlyId === 'string' ? body.friendlyId.trim() : ''
          const friendlyId = requestedFriendlyId || randomUUID()

          const requestedModel =
            typeof body.model === 'string' ? body.model.trim() : ''
          const model = requestedModel || undefined

          if (capabilities.dashboard.available && !capabilities.enhancedChat) {
            return json({
              ok: true,
              sessionKey: friendlyId,
              friendlyId,
              entry: {
                key: friendlyId,
                id: friendlyId,
                title: label || friendlyId,
                label: label || friendlyId,
                derivedTitle: label || friendlyId,
                model: model || '',
                startedAt: Date.now(),
                updatedAt: Date.now(),
                message_count: 0,
                source: 'dashboard',
              },
              modelApplied: Boolean(model),
              persisted: false,
            })
          }

          const session = await createSession({
            id: friendlyId || randomUUID(),
            title: label,
            model,
          })

          return json({
            ok: true,
            sessionKey: session.id,
            friendlyId: session.id,
            entry: cleanGatewaySessionSummary(toSessionSummary(session)),
            modelApplied: true,
          })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
      PATCH: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheckPatch = requireJsonContentType(request)
        if (csrfCheckPatch) return csrfCheckPatch
        const capabilities = await ensureGatewayProbed()
        if (!capabilities.sessions) {
          const body = (await request.json().catch(() => ({}))) as Record<
            string,
            unknown
          >
          const rawSessionKey =
            typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''
          const rawFriendlyId =
            typeof body.friendlyId === 'string' ? body.friendlyId.trim() : ''
          const sessionKey = rawSessionKey || rawFriendlyId || randomUUID()

          return json({
            ...createCapabilityUnavailablePayload('sessions'),
            ok: true,
            sessionKey,
            friendlyId: rawFriendlyId || sessionKey,
            updated: false,
          })
        }
        try {
          const body = (await request.json().catch(() => ({}))) as Record<
            string,
            unknown
          >

          const rawSessionKey =
            typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''
          const rawFriendlyId =
            typeof body.friendlyId === 'string' ? body.friendlyId.trim() : ''
          const label =
            typeof body.label === 'string' ? body.label.trim() : undefined
          const sessionKey = rawSessionKey || rawFriendlyId

          if (!sessionKey) {
            return json(
              { ok: false, error: 'sessionKey required' },
              { status: 400 },
            )
          }

          const localSession = getLocalSession(sessionKey)
          if (localSession) {
            if (label) {
              updateLocalSessionTitle(sessionKey, label)
              // Workspace chats exist in BOTH stores: the local session store
              // AND the agent's session DB (the gateway records api_server
              // sessions). Best-effort propagate the rename so the native
              // dashboard shows the same title instead of the raw first
              // message.
              if (capabilities.dashboard.available) {
                try {
                  await dashboardFetch(
                    `/api/sessions/${encodeURIComponent(sessionKey)}`,
                    {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ title: label }),
                    },
                  )
                } catch {
                  // local rename already applied; dashboard sync is optional
                }
              }
            }
            return json({
              ok: true,
              sessionKey,
              friendlyId: rawFriendlyId || sessionKey,
              entry: {
                key: sessionKey,
                id: sessionKey,
                title: label || sessionKey,
                label: label || sessionKey,
                derivedTitle: label || sessionKey,
                startedAt: localSession.createdAt,
                updatedAt: Date.now(),
                message_count: localSession.messageCount,
                model: localSession.model,
                source: 'local',
              },
              updated: true,
              source: 'local',
            })
          }

          if (capabilities.dashboard.available && !capabilities.enhancedChat) {
            // Rename directly through the agent dashboard (PATCH
            // /api/sessions/{id} resolves friendly ids too). The previous
            // branch returned a fake ok without persisting anything, so
            // workspace-set titles never reached the agent and sessions
            // stayed Untitled/raw-first-message on the native dashboard.
            try {
              const res = await dashboardFetch(
                `/api/sessions/${encodeURIComponent(sessionKey)}`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ title: label ?? '' }),
                },
              )
              const data = (await res.json().catch(() => ({}))) as Record<
                string,
                unknown
              >
              if (!res.ok) {
                return json(
                  {
                    ok: false,
                    error:
                      typeof data.detail === 'string'
                        ? data.detail
                        : 'Rename failed',
                  },
                  { status: res.status },
                )
              }
              const savedTitle =
                typeof data.title === 'string' && data.title
                  ? data.title
                  : label || sessionKey
              return json({
                ok: true,
                sessionKey,
                entry: {
                  key: sessionKey,
                  id: sessionKey,
                  title: savedTitle,
                  label: savedTitle,
                  derivedTitle: savedTitle,
                  updatedAt: Date.now(),
                },
                updated: true,
                source: 'dashboard',
              })
            } catch {
              return json(
                { ok: false, error: 'Agent dashboard unreachable' },
                { status: 502 },
              )
            }
          }

          const session = await updateSession(sessionKey, {
            title: label,
          })

          return json({
            ok: true,
            sessionKey,
            entry: cleanGatewaySessionSummary(toSessionSummary(session)),
          })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
      DELETE: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        const rawSessionKey = url.searchParams.get('sessionKey') ?? ''
        const rawFriendlyId = url.searchParams.get('friendlyId') ?? ''
        const sessionKey = rawSessionKey.trim() || rawFriendlyId.trim()

        if (!sessionKey) {
          return json(
            { ok: false, error: 'sessionKey required' },
            { status: 400 },
          )
        }

        // Local sessions live in the workspace portable store, not the
        // gateway. Delete them locally without hitting the gateway.
        if (getLocalSession(sessionKey)) {
          deleteLocalSession(sessionKey)
          return json({ ok: true, sessionKey, source: 'local' })
        }

        const capabilities = await ensureGatewayProbed()
        if (!capabilities.sessions) {
          return json({
            ...createCapabilityUnavailablePayload('sessions'),
            ok: true,
            sessionKey,
            deleted: false,
          })
        }
        try {
          await deleteSession(sessionKey)

          return json({ ok: true, sessionKey })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
