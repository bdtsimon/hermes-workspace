/**
 * Hermes Dashboard kanban plugin proxy.
 *
 * When `caps.kanban === true` (probed in gateway-capabilities), the
 * dashboard exposes the upstream Hermes kanban plugin at
 * `/api/plugins/kanban/*`. This module is a thin HTTP proxy so the
 * workspace's `/api/swarm-kanban/*` routes can talk to the dashboard
 * without touching SQLite directly.
 *
 * Why proxy at all when we also have direct-SQLite read/write
 * (see kanban-backend.ts)? Two reasons:
 *
 *   1. **Remote workspaces.** When the workspace runs in Docker/VPS
 *      and the agent runs elsewhere, the SQLite file isn't on the
 *      same filesystem. HTTP is the only viable path.
 *   2. **Single source of truth + dispatcher integration.** The
 *      dashboard's plugin_api.py wraps writes inside the same
 *      transactional helpers the dispatcher uses. Going through
 *      HTTP keeps the workspace from racing the dispatcher on
 *      `running` vs `claimed` state.
 *
 * This module is only used when `caps.kanban === true`. Otherwise
 * kanban-backend.ts falls through to the local file-backed store.
 *
 * Auth: all calls go through the shared `dashboardFetch` channel from
 * gateway-capabilities — on loopback binds that injects the scraped
 * session token, on GATED basic-auth binds it performs the cookie
 * login. The previous hand-rolled header builder sent a bare (often
 * empty) bearer, which gated dashboards reject with 401 `no_cookie`.
 *
 * See v2.3.0 plan.
 */
import { dashboardFetch } from './gateway-capabilities'

const PROXY_TIMEOUT_MS = 10_000

export type DashboardKanbanTask = {
  id: string
  title: string
  body?: string | null
  assignee?: string | null
  status: string
  priority?: number | null
  created_by?: string | null
  created_at?: number | null
  started_at?: number | null
  completed_at?: number | null
  workspace_kind?: string | null
  workspace_path?: string | null
}

export type DashboardKanbanBoardResponse = {
  columns: Array<{
    name: string
    tasks: Array<DashboardKanbanTask>
  }>
}

function withParams(
  path: string,
  params: Record<string, string | undefined> = {},
): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value)
  }
  const query = search.toString()
  return query ? `${path}?${query}` : path
}

async function proxyFetch<T>(
  path: string,
  init: RequestInit = {},
  params: Record<string, string | undefined> = {},
): Promise<T> {
  const res = await dashboardFetch(withParams(path, params), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Dashboard kanban proxy: ${init.method || 'GET'} ${path} → ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`,
    )
  }
  return (await res.json()) as T
}

/** Fetch the full board (all columns + tasks) from the dashboard plugin. */
export function fetchDashboardKanbanBoard(
  board?: string,
): Promise<DashboardKanbanBoardResponse> {
  return proxyFetch<DashboardKanbanBoardResponse>(
    '/api/plugins/kanban/board',
    {},
    board ? { board } : {},
  )
}

/** Fetch one task by id. Returns null on 404. */
export async function fetchDashboardKanbanTask(
  taskId: string,
  board?: string,
): Promise<DashboardKanbanTask | null> {
  try {
    const wrapped = await proxyFetch<{ task?: DashboardKanbanTask }>(
      `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}`,
      {},
      board ? { board } : {},
    )
    return wrapped.task ?? null
  } catch (err) {
    if (err instanceof Error && err.message.includes('→ 404')) return null
    throw err
  }
}

export type CreateDashboardKanbanTaskInput = {
  title: string
  body?: string
  assignee?: string | null
  status?: string
  priority?: number
  created_by?: string
  workspace_kind?: string
  workspace_path?: string
}

/** Create a task on the dashboard board. */
export async function createDashboardKanbanTask(
  input: CreateDashboardKanbanTaskInput,
  board?: string,
): Promise<DashboardKanbanTask> {
  const wrapped = await proxyFetch<{ task: DashboardKanbanTask }>(
    '/api/plugins/kanban/tasks',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    board ? { board } : {},
  )
  return wrapped.task
}

export type UpdateDashboardKanbanTaskInput = {
  title?: string
  body?: string
  assignee?: string | null
  status?: string
  priority?: number
}

/** Patch a task on the dashboard board. */
export async function updateDashboardKanbanTask(
  taskId: string,
  updates: UpdateDashboardKanbanTaskInput,
  board?: string,
): Promise<DashboardKanbanTask> {
  const wrapped = await proxyFetch<{ task: DashboardKanbanTask }>(
    `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(updates),
    },
    board ? { board } : {},
  )
  return wrapped.task
}

/**
 * List boards. The dashboard kanban plugin supports multi-board (project
 * scoping); each board is a separate SQLite file under
 * `<hermes-root>/kanban/boards/<slug>/kanban.db`. The first board is
 * always `default` and lives at `<hermes-root>/kanban.db` for back-compat.
 */
export type DashboardKanbanBoard = {
  slug: string
  display_name?: string | null
  archived?: boolean
}

export function listDashboardKanbanBoards(): Promise<{
  boards: Array<DashboardKanbanBoard>
  current: string
}> {
  return proxyFetch('/api/plugins/kanban/boards')
}
