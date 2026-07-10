import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { z } from 'zod'

import { isAuthenticated } from '../../server/auth-middleware'
import {
  BEARER_TOKEN,
  CLAUDE_API,
  dashboardFetch,
} from '../../server/gateway-capabilities'

const BodySchema = z.object({
  firstUser: z.string().min(1).max(2000),
  firstAssistant: z.string().max(2000).optional(),
})

// One cheap non-streaming completion on the gateway's default model produces
// a short contextual session title. The agent's own TUI gets these from its
// title_generation auxiliary task, but nothing ever titles api_server
// sessions — this route pairs with use-auto-session-title, which falls back
// to the truncated first user message when generation fails.
export const Route = createFileRoute('/api/session-title')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
        }
        const parsed = BodySchema.safeParse(body)
        if (!parsed.success) {
          return json({ ok: false, error: 'Invalid body' }, { status: 400 })
        }
        const { firstUser, firstAssistant } = parsed.data
        try {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          }
          if (BEARER_TOKEN) headers.Authorization = `Bearer ${BEARER_TOKEN}`
          const res = await fetch(`${CLAUDE_API}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              stream: false,
              max_tokens: 24,
              temperature: 0.2,
              messages: [
                {
                  role: 'user',
                  // Small models slide into conversation mode when the
                  // transcript sits bare in the user turn — fence it and put
                  // the instruction in the user message, ending with a cue.
                  content:
                    `Give this chat session a short title: 3 to 5 words, same language as the conversation, no quotes, no trailing punctuation. Reply with the title ONLY.\n\n--- TRANSCRIPT ---\nUser: ${firstUser}\nAssistant: ${firstAssistant || ''}\n--- END ---\n\nTitle:`.slice(
                      0,
                      3000,
                    ),
                },
              ],
            }),
            signal: AbortSignal.timeout(20000),
          })
          // The gateway records even stateless completions in the session
          // ledger — delete the entry this title request just minted so
          // titling a conversation doesn't litter the dashboard with
          // 'Give this chat session a short title...' sessions.
          const junkSessionId = res.headers.get('x-hermes-session-id') || ''
          if (junkSessionId) {
            void dashboardFetch(
              `/api/sessions/${encodeURIComponent(junkSessionId)}`,
              { method: 'DELETE' },
            ).catch(() => {})
          }
          if (!res.ok) {
            return json(
              { ok: false, error: `Completion failed (${res.status})` },
              { status: 502 },
            )
          }
          const data = (await res.json().catch(() => ({}))) as {
            choices?: Array<{ message?: { content?: unknown } }>
          }
          const raw = data.choices?.[0]?.message?.content
          // Strict validation: first line only, stripped of quotes/markdown;
          // anything sentence-length means the model rambled — report failure
          // so the caller falls back to the truncated first user message.
          const firstLine =
            typeof raw === 'string' ? raw.split('\n')[0] : ''
          const title = firstLine
            .replace(/^\s*(tytu\u0142|title)\s*:\s*/i, '')
            .replace(/["'`*_#]+/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/[.!?]+\s*$/, '')
            .trim()
            .slice(0, 60)
          const wordCount = title ? title.split(' ').length : 0
          if (!title || wordCount > 10) {
            return json(
              { ok: false, error: 'Model did not return a title' },
              { status: 502 },
            )
          }
          return json({ ok: true, title })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : 'Network error',
            },
            { status: 502 },
          )
        }
      },
    },
  },
})
