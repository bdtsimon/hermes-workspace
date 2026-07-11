import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  dashboardFetch,
  ensureGatewayProbed,
  getCapabilities,
} from './gateway-capabilities'

export type MemoryFileMeta = {
  path: string
  name: string
  size: number
  modified: string
}

export type MemorySearchMatch = {
  path: string
  line: number
  text: string
}

// Root-level files the agent auto-injects each session — the persona/operating
// identity (SOUL.md), the operating rules (AGENTS.md) and the operator profile
// (USER.md), plus the top-level MEMORY.md. Surfaced in the Memory tab so the
// operator can see and edit the files that actually shape the agent, not only
// its running memory under memories/.
const ROOT_MEMORY_FILES = ['SOUL.md', 'AGENTS.md', 'USER.md', 'MEMORY.md']

function isBrowserMemoryPath(relativePath: string): boolean {
  return (
    ROOT_MEMORY_FILES.includes(relativePath) ||
    relativePath.startsWith('memory/') ||
    relativePath.startsWith('memories/')
  )
}

function normalizeWorkspaceRoot(): string {
  // Honor HERMES_HOME when set (e.g. ~/.hermes-vanilla for running alongside prod).
  // Fall back to ~/.hermes for the default install location.
  const envHome = (process.env.HERMES_HOME || process.env.CLAUDE_HOME)?.trim()
  const resolved = envHome ? path.resolve(envHome) : path.resolve(path.join(os.homedir(), '.hermes'))
  return resolved
}

export function getMemoryWorkspaceRoot(): string {
  return path.resolve(normalizeWorkspaceRoot())
}

function normalizeRelativeMemoryPath(input: string): string {
  const normalized = input.replace(/\\/g, '/').trim()
  if (!normalized) throw new Error('Path is required')
  if (normalized.startsWith('/'))
    throw new Error('Absolute paths are not allowed')
  if (normalized.includes('..'))
    throw new Error('Path traversal is not allowed')
  if (!normalized.toLowerCase().endsWith('.md'))
    throw new Error('Only Markdown files are allowed')
  return normalized
}

export function resolveMemoryFilePath(relativePath: string): {
  fullPath: string
  relativePath: string
} {
  const safeRelativePath = normalizeRelativeMemoryPath(relativePath)
  const workspaceRoot = getMemoryWorkspaceRoot()
  const fullPath = path.resolve(workspaceRoot, safeRelativePath)
  if (!fullPath.startsWith(workspaceRoot)) {
    throw new Error('Resolved path is outside workspace')
  }
  return { fullPath, relativePath: safeRelativePath }
}

function pushIfMarkdownFile(
  entries: Array<MemoryFileMeta>,
  workspaceRoot: string,
  fullPath: string,
) {
  if (!fullPath.toLowerCase().endsWith('.md')) return
  let stats: fs.Stats
  try {
    stats = fs.statSync(fullPath)
  } catch {
    return
  }
  if (!stats.isFile()) return

  const relativePath = path
    .relative(workspaceRoot, fullPath)
    .replace(/\\/g, '/')
  if (!isBrowserMemoryPath(relativePath)) return

  entries.push({
    path: relativePath,
    name: path.basename(fullPath),
    size: stats.size,
    modified: stats.mtime.toISOString(),
  })
}

function shouldSkipDirectory(name: string): boolean {
  return name === '.git' || name === 'node_modules'
}

function walkWorkspaceDir(
  entries: Array<MemoryFileMeta>,
  workspaceRoot: string,
  dirPath: string,
) {
  let dirEntries: Array<string>
  try {
    dirEntries = fs.readdirSync(dirPath)
  } catch {
    return
  }

  for (const name of dirEntries) {
    const fullPath = path.join(dirPath, name)
    let stats: fs.Stats
    try {
      stats = fs.statSync(fullPath)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      if (shouldSkipDirectory(name)) continue
      walkWorkspaceDir(entries, workspaceRoot, fullPath)
      continue
    }
    pushIfMarkdownFile(entries, workspaceRoot, fullPath)
  }
}

function compareMemoryFiles(a: MemoryFileMeta, b: MemoryFileMeta): number {
  // Root config/identity files first, in ROOT_MEMORY_FILES order (SOUL, AGENTS,
  // USER, MEMORY), so the files that shape the agent sit at the top of the tab.
  const aRank = ROOT_MEMORY_FILES.indexOf(a.path)
  const bRank = ROOT_MEMORY_FILES.indexOf(b.path)
  if (aRank !== -1 || bRank !== -1) {
    if (aRank === -1) return 1
    if (bRank === -1) return -1
    return aRank - bRank
  }

  const aIsDaily = /^memories?\/\d{4}-\d{2}-\d{2}\.md$/.test(a.path)
  const bIsDaily = /^memories?\/\d{4}-\d{2}-\d{2}\.md$/.test(b.path)
  if (aIsDaily && bIsDaily) return b.path.localeCompare(a.path)

  const modifiedDiff = Date.parse(b.modified) - Date.parse(a.modified)
  if (modifiedDiff !== 0) return modifiedDiff
  return a.path.localeCompare(b.path)
}

export function listMemoryFiles(): Array<MemoryFileMeta> {
  const workspaceRoot = getMemoryWorkspaceRoot()
  const results: Array<MemoryFileMeta> = []

  for (const rootFile of ROOT_MEMORY_FILES) {
    pushIfMarkdownFile(results, workspaceRoot, path.join(workspaceRoot, rootFile))
  }
  for (const subdir of ['memory', 'memories']) {
    walkWorkspaceDir(results, workspaceRoot, path.join(workspaceRoot, subdir))
  }

  results.sort(compareMemoryFiles)
  return results
}

export function readMemoryFile(relativePath: string): string {
  const { fullPath } = resolveMemoryFilePath(relativePath)
  return fs.readFileSync(fullPath, 'utf-8')
}

export function searchMemoryFiles(query: string): Array<MemorySearchMatch> {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  const matches: Array<MemorySearchMatch> = []
  const files = listMemoryFiles()

  for (const file of files) {
    let content = ''
    try {
      content = readMemoryFile(file.path)
    } catch {
      continue
    }
    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index] || ''
      if (!text.toLowerCase().includes(needle)) continue
      matches.push({
        path: file.path,
        line: index + 1,
        text,
      })
      if (matches.length >= 200) return matches
    }
  }

  return matches
}

// ── Agent-backed memory (A/B-store unification) ─────────────────────────
//
// The agent's built-in memory lives in ITS data dir (our deploy: /opt/data →
// memories/MEMORY.md + memories/USER.md), not in the workspace's HERMES_HOME —
// so the local reads above see an empty directory on split deployments and the
// Memory tab lied with "No memory files found" while the agent had content.
// The dashboard files API (GET /api/files, /api/files/read, POST
// /api/files/upload — token-authed via dashboardFetch) is the stable channel
// to that data; local files remain the fallback when the dashboard is down.
// Writes NEVER silently fall back while the agent is reachable — that would
// split-brain the memory.

const AGENT_HOME = (process.env.HERMES_AGENT_HOME || '/opt/data')
  .trim()
  .replace(/\/+$/, '')

export type MemorySource = 'agent' | 'local'

async function dashboardMemoryAvailable(): Promise<boolean> {
  try {
    const caps = await ensureGatewayProbed()
    return caps.dashboard.available === true
  } catch {
    return getCapabilities().dashboard.available === true
  }
}

function toIsoModified(value: unknown): string {
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: seconds vs milliseconds epoch.
    return new Date(value > 1e12 ? value : value * 1000).toISOString()
  }
  return new Date(0).toISOString()
}

async function dashListDir(relDir: string): Promise<Array<MemoryFileMeta>> {
  const absPath = relDir ? `${AGENT_HOME}/${relDir}` : AGENT_HOME
  const res = await dashboardFetch(
    `/api/files?path=${encodeURIComponent(absPath)}`,
  )
  if (!res.ok) return []
  const data = (await res.json().catch(() => ({}))) as {
    entries?: Array<Record<string, unknown>>
  }
  const out: Array<MemoryFileMeta> = []
  for (const entry of data.entries || []) {
    const name = typeof entry.name === 'string' ? entry.name : ''
    if (!name || entry.is_directory === true) continue
    if (!name.toLowerCase().endsWith('.md')) continue
    out.push({
      path: relDir ? `${relDir}/${name}` : name,
      name,
      size: typeof entry.size === 'number' ? entry.size : 0,
      modified: toIsoModified(entry.modified ?? entry.mtime),
    })
  }
  return out
}

export async function listMemoryFilesUnified(): Promise<{
  files: Array<MemoryFileMeta>
  source: MemorySource
}> {
  if (await dashboardMemoryAvailable()) {
    try {
      const [root, memoryDir, memoriesDir] = await Promise.all([
        dashListDir(''),
        dashListDir('memory'),
        dashListDir('memories'),
      ])
      const files = [
        ...root.filter((file) => ROOT_MEMORY_FILES.includes(file.path)),
        ...memoryDir,
        ...memoriesDir,
      ]
      files.sort(compareMemoryFiles)
      // The agent answered — its view is the truth, even when empty.
      return { files, source: 'agent' }
    } catch {
      // dashboard hiccup — fall back to local below
    }
  }
  return { files: listMemoryFiles(), source: 'local' }
}

export async function readMemoryFileUnified(relativePath: string): Promise<{
  content: string
  source: MemorySource
}> {
  const safe = normalizeRelativeMemoryPath(relativePath)
  if (await dashboardMemoryAvailable()) {
    let agentAnswered = false
    try {
      const res = await dashboardFetch(
        `/api/files/read?path=${encodeURIComponent(`${AGENT_HOME}/${safe}`)}`,
      )
      agentAnswered = true
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          data_url?: unknown
        }
        const match =
          typeof data.data_url === 'string'
            ? /^data:[^;,]*(?:;base64)?,(.*)$/.exec(data.data_url)
            : null
        if (match && typeof data.data_url === 'string') {
          const content = data.data_url.includes(';base64,')
            ? Buffer.from(match[1], 'base64').toString('utf-8')
            : decodeURIComponent(match[1])
          return { content, source: 'agent' }
        }
      }
      if (res.status === 404) {
        throw new Error(`ENOENT: memory file not found: ${safe}`)
      }
    } catch (error) {
      if (agentAnswered && error instanceof Error && /ENOENT/.test(error.message)) {
        throw error
      }
      // network/dashboard failure — fall back to local below
    }
  }
  return { content: readMemoryFile(safe), source: 'local' }
}

export async function writeMemoryFileUnified(
  relativePath: string,
  content: string,
): Promise<{ source: MemorySource; path: string }> {
  const safe = normalizeRelativeMemoryPath(relativePath)
  if (await dashboardMemoryAvailable()) {
    // While the agent is reachable, its store is the ONLY write target —
    // a silent local fallback would fork the memory into two truths.
    const dataUrl =
      'data:text/markdown;base64,' +
      Buffer.from(content, 'utf-8').toString('base64')
    const res = await dashboardFetch('/api/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: `${AGENT_HOME}/${safe}`,
        data_url: dataUrl,
        overwrite: true,
      }),
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        detail?: unknown
      }
      throw new Error(
        typeof data.detail === 'string' && data.detail
          ? data.detail
          : `Agent memory write failed (${res.status})`,
      )
    }
    return { source: 'agent', path: safe }
  }
  const { fullPath } = resolveMemoryFilePath(safe)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf-8')
  return { source: 'local', path: safe }
}

export async function searchMemoryFilesUnified(query: string): Promise<{
  results: Array<MemorySearchMatch>
  source: MemorySource
}> {
  const needle = query.trim().toLowerCase()
  if (!needle) return { results: [], source: 'agent' }

  const { files, source } = await listMemoryFilesUnified()
  if (source === 'local') {
    return { results: searchMemoryFiles(query), source }
  }

  const matches: Array<MemorySearchMatch> = []
  for (const file of files.slice(0, 30)) {
    let content = ''
    try {
      const read = await readMemoryFileUnified(file.path)
      content = read.content
    } catch {
      continue
    }
    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index] || ''
      if (!text.toLowerCase().includes(needle)) continue
      matches.push({ path: file.path, line: index + 1, text })
      if (matches.length >= 200) return { results: matches, source }
    }
  }
  return { results: matches, source }
}
