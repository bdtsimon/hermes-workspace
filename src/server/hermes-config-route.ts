import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import { createCapabilityUnavailablePayload } from '@/lib/feature-gates'

import { isAuthenticated } from './auth-middleware'
import {
  dashboardFetch,
  ensureGatewayProbed,
  getCapabilities,
} from './gateway-capabilities'
import { normalizeHermesConfigState } from './hermes-config-migration'
import {
  applyHermesConfigPatch,
  parseEnvFile,
  readHermesConfigFiles,
  resolveHermesConfigPaths,
  stringifyEnv,
} from './hermes-config-store'
import {
  ensureDiscovery,
  getDiscoveredModels,
  getDiscoveryStatus,
} from './local-provider-discovery'

type AuthResult = Response | true

// WRITE-THROUGH (2026-07-10): config reads and writes are brokered through the
// AGENT's dashboard API instead of the local config.yaml file.
//
//   read   GET  /api/config          — the agent process's live view
//   model  POST /api/model/set       — native semantics: applies to NEW
//                                      sessions immediately (same as the agent
//                                      dashboard; a running chat hot-swaps only
//                                      via the /model slash command)
//   other  PUT  /api/config          — deep-merges incoming over disk, exactly
//                                      the legacy local semantics
//
// Why not the file: the agent saves its config via an atomic temp+rename
// (inode replaced, group ownership reverts to the agent user), so any
// file-level sharing goes stale or unreadable after the first agent-side
// save. The dashboard API is the only stable contract. Local files remain
// for the workspace-side .env (API keys) and as a read fallback when the
// dashboard is unreachable.
const ACTION_MESSAGES: Record<string, string> = {
  'set-default-model': 'Default model updated — applies to new sessions.',
  'set-api-key': 'API key saved.',
  'remove-api-key': 'API key removed.',
  'set-custom-provider': 'Custom provider saved.',
  'remove-custom-provider': 'Custom provider removed.',
}

const LEGACY_SAVE_MESSAGE = 'Saved.'

const PatchActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set-default-model'),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
  }),
  z.object({
    action: z.literal('set-api-key'),
    envKey: z.string().min(1),
    value: z.string(),
  }),
  z.object({
    action: z.literal('remove-api-key'),
    envKey: z.string().min(1),
  }),
  z.object({
    action: z.literal('set-custom-provider'),
    provider: z.object({
      name: z.string().min(1),
      baseUrl: z.string().min(1),
      apiKeyEnv: z.string().optional(),
      apiMode: z.string().optional(),
    }),
  }),
  z.object({
    action: z.literal('remove-custom-provider'),
    name: z.string().min(1),
  }),
])

const LegacyPatchSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
})

async function authorize(request: Request): Promise<AuthResult> {
  const result = isAuthenticated(request) as AuthResult
  if (result !== true) return result
  await ensureGatewayProbed()
  return true
}

function unavailablePayload(extra: Record<string, unknown> = {}): Response {
  return Response.json({
    ...createCapabilityUnavailablePayload('config'),
    config: {},
    providers: [],
    customProviders: [],
    activeProvider: '',
    activeModel: '',
    ...extra,
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readErrorDetail(data: unknown, fallback: string): string {
  const record = asRecord(data)
  if (typeof record.detail === 'string' && record.detail) return record.detail
  if (typeof record.error === 'string' && record.error) return record.error
  if (typeof record.message === 'string' && record.message) return record.message
  return fallback
}

async function fetchAgentConfig(): Promise<Record<string, unknown> | null> {
  try {
    const res = await dashboardFetch('/api/config')
    if (!res.ok) return null
    const data: unknown = await res.json().catch(() => null)
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

async function putAgentConfig(
  updates: Record<string, unknown>,
): Promise<{ ok: boolean; message?: string; status?: number }> {
  try {
    const res = await dashboardFetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: updates }),
    })
    if (res.ok) return { ok: true }
    const data: unknown = await res.json().catch(() => ({}))
    return {
      ok: false,
      status: res.status,
      message: readErrorDetail(data, 'The agent config API rejected the update'),
    }
  } catch {
    return {
      ok: false,
      status: 502,
      message: 'Agent dashboard unreachable — configuration unchanged.',
    }
  }
}

function readCustomProvidersList(
  config: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const entries = config.custom_providers
  return Array.isArray(entries)
    ? entries.filter((entry): entry is Record<string, unknown> => {
        return Boolean(entry && typeof entry === 'object' && !Array.isArray(entry))
      })
    : []
}

function customProviderName(entry: Record<string, unknown>): string {
  const name = entry.name
  if (typeof name === 'string' && name.trim()) return name.trim()
  const id = entry.id
  return typeof id === 'string' ? id.trim() : ''
}

async function setDefaultModelViaAgent(
  providerId: string,
  modelId: string,
): Promise<Response> {
  try {
    const res = await dashboardFetch('/api/model/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'main', provider: providerId, model: modelId }),
    })
    const data: unknown = await res.json().catch(() => ({}))
    const record = asRecord(data)
    if (res.ok && record.confirm_required === true) {
      // The agent's expensive-model guard. Surface its warning instead of
      // silently confirming a potentially costly model on the user's behalf.
      const warning =
        typeof record.confirm_message === 'string' && record.confirm_message
          ? record.confirm_message
          : 'The agent flagged this model as expensive — confirm the change on the agent dashboard.'
      return Response.json({ ok: false, message: warning })
    }
    if (res.ok) {
      return Response.json({ ok: true, message: ACTION_MESSAGES['set-default-model'] })
    }
    return Response.json(
      {
        ok: false,
        message: readErrorDetail(data, 'The agent config API rejected the model change'),
      },
      { status: res.status },
    )
  } catch {
    return Response.json(
      { ok: false, message: 'Agent dashboard unreachable — model unchanged.' },
      { status: 502 },
    )
  }
}

export async function handleHermesConfigGet({
  request,
}: {
  request: Request
}): Promise<Response> {
  const auth = await authorize(request)
  if (auth !== true) return auth

  const paths = resolveHermesConfigPaths()
  if (!getCapabilities().config) {
    return unavailablePayload({ paths, claudeHome: paths.hermesHome })
  }

  await ensureDiscovery()
  const files = readHermesConfigFiles(paths)
  // Prefer the agent's live config; fall back to the local file only when the
  // dashboard cannot be reached (the file may be a stale mirror).
  const agentConfig = await fetchAgentConfig()
  const state = normalizeHermesConfigState({
    paths,
    config: agentConfig ?? files.config,
    env: files.env,
    authProfiles: files.authProfiles,
    localProviders: getDiscoveryStatus(),
    localModels: getDiscoveredModels(),
  })

  // Legacy /api/claude-config consumers read provider.maskedKeys; alias it.
  const providers = state.providers.map((p) => ({
    ...p,
    maskedKeys: p.maskedCredentials,
  }))

  return Response.json({
    ...state,
    providers,
    claudeHome: paths.hermesHome,
    configSource: agentConfig ? 'agent-api' : 'file',
  })
}

function applyLegacyEnvBody(
  envPath: string,
  envUpdates: Record<string, string | null>,
): void {
  let current: Record<string, string> = {}
  try {
    current = parseEnvFile(fs.readFileSync(envPath, 'utf-8'))
  } catch {}

  for (const [key, value] of Object.entries(envUpdates)) {
    if (value === '' || value === null) delete current[key]
    else current[key] = value
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true })
  fs.writeFileSync(envPath, stringifyEnv(current), 'utf-8')
}

export async function handleHermesConfigPatch({
  request,
}: {
  request: Request
}): Promise<Response> {
  const auth = await authorize(request)
  if (auth !== true) return auth

  if (!getCapabilities().config) {
    return new Response(
      JSON.stringify(
        createCapabilityUnavailablePayload('config', {
          error: 'Configuration updates are unavailable on this backend.',
        }),
      ),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const paths = resolveHermesConfigPaths()
  const hasAction =
    body !== null &&
    typeof body === 'object' &&
    typeof (body as { action?: unknown }).action === 'string'

  if (hasAction) {
    const parsed = PatchActionSchema.safeParse(body)
    if (!parsed.success) {
      return Response.json(
        { ok: false, error: 'Invalid patch action body', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const patch = parsed.data

    if (patch.action === 'set-default-model') {
      return setDefaultModelViaAgent(patch.providerId, patch.modelId)
    }

    if (
      patch.action === 'set-custom-provider' ||
      patch.action === 'remove-custom-provider'
    ) {
      const agentConfig = await fetchAgentConfig()
      if (!agentConfig) {
        return Response.json(
          { ok: false, message: 'Agent dashboard unreachable — configuration unchanged.' },
          { status: 502 },
        )
      }
      const list = readCustomProvidersList(agentConfig)
      let next: Array<Record<string, unknown>>
      if (patch.action === 'set-custom-provider') {
        next = list.filter(
          (entry) => customProviderName(entry) !== patch.provider.name,
        )
        const entry: Record<string, unknown> = {
          name: patch.provider.name,
          base_url: patch.provider.baseUrl,
        }
        if (patch.provider.apiKeyEnv) entry.key_env = patch.provider.apiKeyEnv
        if (patch.provider.apiMode) entry.api_mode = patch.provider.apiMode
        next = [...next, entry]
      } else {
        next = list.filter((entry) => customProviderName(entry) !== patch.name)
      }
      const result = await putAgentConfig({ custom_providers: next })
      if (!result.ok) {
        return Response.json(
          { ok: false, message: result.message },
          { status: result.status || 500 },
        )
      }
      return Response.json({ ok: true, message: ACTION_MESSAGES[patch.action] })
    }

    // API-key actions manage the WORKSPACE-side ~/.hermes/.env — deliberately
    // local (the agent's own keys live in its data dir and are managed from
    // the agent dashboard's Keys tab).
    const result = applyHermesConfigPatch(paths, patch)
    return Response.json({ ...result, message: ACTION_MESSAGES[patch.action] })
  }

  const legacy = LegacyPatchSchema.safeParse(body)
  if (!legacy.success) {
    return Response.json(
      { ok: false, error: 'Invalid request body', issues: legacy.error.issues },
      { status: 400 },
    )
  }

  if (legacy.data.config) {
    const result = await putAgentConfig(legacy.data.config)
    if (!result.ok) {
      return Response.json(
        { ok: false, message: result.message },
        { status: result.status || 500 },
      )
    }
  }
  if (legacy.data.env) applyLegacyEnvBody(paths.envPath, legacy.data.env)

  return Response.json({ ok: true, message: LEGACY_SAVE_MESSAGE })
}
