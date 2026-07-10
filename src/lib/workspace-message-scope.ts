export type WorkspaceScope = {
  path?: string
  folderName?: string
  isValid?: boolean
}

// Unanchored + global: the directive is appended as a SUFFIX for new
// messages (see buildWorkspaceScopedTextMessage), while sessions from the
// prefix era still carry it up front — strip it wherever it sits.
const WORKSPACE_DIRECTIVE_RE =
  /\s*<workspace_context\s+active="true"\s+name="[^"]*"\s+path="[^"]*"\s*\/?>\s*/gi

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function buildWorkspaceDirective(workspace: WorkspaceScope): string {
  const path = workspace.path?.trim() ?? ''
  if (!path || workspace.isValid === false) return ''
  const name = workspace.folderName?.trim() || path.split('/').filter(Boolean).at(-1) || 'workspace'
  return `<workspace_context active="true" name="${escapeAttribute(name)}" path="${escapeAttribute(path)}" />`
}

export function buildWorkspaceScopedTextMessage(
  message: string,
  workspace: WorkspaceScope | null | undefined,
): string {
  if (message.includes('<workspace_context active="true"')) return message
  const directive = workspace ? buildWorkspaceDirective(workspace) : ''
  if (!directive) return message
  // SUFFIX, not prefix: the agent does not parse this tag anywhere (it is a
  // prompt-level convention, position-agnostic for the LLM), but it DOES name
  // new sessions from the first message's leading text — a prefixed tag turned
  // every workspace-started session title into raw markup on the native
  // dashboard. Trailing placement keeps titles = the user's own words.
  return `${message}\n\n${directive}`
}

export function stripWorkspaceDirective(message: string): string {
  if (!message.includes('<workspace_context active="true"')) return message
  return message.replace(WORKSPACE_DIRECTIVE_RE, '\n').trim()
}
