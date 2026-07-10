import fs from 'node:fs'

import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { z } from 'zod'

import { isAuthenticated } from '../../server/auth-middleware'
import {
  BEARER_TOKEN,
  CLAUDE_API,
  dashboardFetch,
} from '../../server/gateway-capabilities'
import {
  parseEnvFile,
  resolveHermesConfigPaths,
} from '../../server/hermes-config-store'

const BodySchema = z.object({
  firstUser: z.string().min(1).max(2000),
  firstAssistant: z.string().max(2000).optional(),
})

// The agent's own TUI titles sessions through an INTERNAL auxiliary task that
// never touches the HTTP surface, so api_server sessions have no native
// titling channel. This route provides one, preferring paths that leave no
// trace in the session ledger:
//
//   1. Direct OpenRouter call on a free model (the workspace already holds
//      OPENROUTER_API_KEY in its own ~/.hermes/.env) — no gateway involved,
//      nothing recorded anywhere.
//   2. Gateway completions on the default model — the gateway records even
//      stateless calls, so the minted ledger session is deleted right after
//      (X-Hermes-Session-Id response header).
//   3. Caller-side fallback: the truncated first user message.
const OPENROUTER_TITLE_MODEL = 'nvidia/nemotron-3-nano-30b-a3b:free'

function buildPrompt(firstUser: string, firstAssistant: string): string {
  return `Give this chat session a short title: 3 to 5 words, same language as the conversation, no quotes, no trailing punctuation. Reply with the title ONLY.\n\n--- TRANSCRIPT ---\nUser: ${firstUser}\nAssistant: ${firstAssistant}\n--- END ---\n\nTitle:`.slice(
    0,
    3000,
  )
}

// Strict validation on the LAST non-empty line: reasoning models emit their
// thinking first and the answer last, plain models emit a single line — the
// last line covers both. Anything sentence-length means the model rambled —
// return '' so the next path (or the caller's truncate fallback) takes over.
function extractTitle(raw: unknown): string {
  const lines =
    typeof raw === 'string'
      ? raw
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      : []
  const lastLine = lines.length ? lines[lines.length - 1] : ''
  const title = lastLine
    .replace(/^\s*(tytuł|title)\s*:\s*/i, '')
    .replace(/["'`*_#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+\s*$/, '')
    .trim()
    .slice(0, 60)
  const wordCount = title ? title.split(' ').length : 0
  if (!title || wordCount > 10) return ''
  return title
}

function readWorkspaceEnvKey(name: string): string {
  try {
    const paths = resolveHermesConfigPaths()
    const env = parseEnvFile(fs.readFileSync(paths.envPath, 'utf-8'))
    return (env[name] || '').trim()
  } catch {
    return ''
  }
}

async function titleViaOpenRouter(prompt: string): Promise<string> {
  const key = readWorkspaceEnvKey('OPENROUTER_API_KEY')
  if (!key) return ''
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENROUTER_TITLE_MODEL,
        // Reasoning models spend tokens thinking before the one-line answer —
        // 24 tokens starved the free nemotron into finish_reason=length.
        max_tokens: 256,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return ''
    const data = (await res.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: unknown } }>
    }
    return extractTitle(data.choices?.[0]?.message?.content)
  } catch {
    return ''
  }
}

async function titleViaGateway(prompt: string): Promise<string> {
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
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(20000),
    })
    // The gateway records even stateless completions in the session ledger —
    // delete the entry this request just minted so titling a conversation
    // doesn't litter the dashboard.
    const junkSessionId = res.headers.get('x-hermes-session-id') || ''
    if (junkSessionId) {
      void dashboardFetch(
        `/api/sessions/${encodeURIComponent(junkSessionId)}`,
        { method: 'DELETE' },
      ).catch(() => {})
    }
    if (!res.ok) return ''
    const data = (await res.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: unknown } }>
    }
    return extractTitle(data.choices?.[0]?.message?.content)
  } catch {
    return ''
  }
}

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
        const prompt = buildPrompt(
          parsed.data.firstUser,
          parsed.data.firstAssistant || '',
        )

        const viaOpenRouter = await titleViaOpenRouter(prompt)
        if (viaOpenRouter) {
          return json({ ok: true, title: viaOpenRouter, via: 'openrouter' })
        }
        const viaGateway = await titleViaGateway(prompt)
        if (viaGateway) {
          return json({ ok: true, title: viaGateway, via: 'gateway' })
        }
        return json(
          { ok: false, error: 'Model did not return a title' },
          { status: 502 },
        )
      },
    },
  },
})
