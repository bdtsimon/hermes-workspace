import { useEffect, useMemo, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { chatQueryKeys } from '../chat-queries'
import {
  updateSessionTitleState,
  useSessionTitleInfo,
} from '../session-title-store'
import { textFromMessage } from '../utils'
import type { ChatMessage, SessionMeta } from '../types'

const MAX_TITLE_LENGTH = 50

const GENERIC_TITLE_PATTERNS = [
  /^a new session/i,
  /^new session/i,
  /^untitled/i,
  /^session \d/i,
  /^conversation$/i,
  /^chat$/i,
  /^local chat$/i,
  /^[0-9a-f]{6,}/i,
  /^\w{8} \(\d{4}-\d{2}-\d{2}\)$/,
]

export function isGenericTitle(title: string): boolean {
  const trimmed = title.trim()
  if (!trimmed || trimmed === 'New Session') return true
  return GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed))
}

function truncateTitle(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= MAX_TITLE_LENGTH) return normalized
  return `${normalized.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
}

function getFirstUserMessage(messages: Array<ChatMessage>): string {
  const firstUser = messages.find((message) => message.role === 'user')
  return firstUser ? textFromMessage(firstUser).trim() : ''
}

function hasAssistantResponse(messages: Array<ChatMessage>): boolean {
  return messages.some((message) => {
    if (message.role !== 'assistant') return false
    return textFromMessage(message).trim().length > 0
  })
}

type UseAutoSessionTitleInput = {
  friendlyId: string
  sessionKey: string | undefined
  activeSession?: SessionMeta
  messages: Array<ChatMessage>
  messageCount?: number
  enabled: boolean
}

type UpdateTitlePayload = {
  friendlyId: string
  sessionKey: string
  title: string
}

export function useAutoSessionTitle({
  friendlyId,
  sessionKey,
  activeSession,
  messages,
  enabled,
}: UseAutoSessionTitleInput) {
  const queryClient = useQueryClient()
  const titleInfo = useSessionTitleInfo(friendlyId)
  const lastAttemptRef = useRef<Record<string, string>>({})

  const proposedTitle = useMemo(() => {
    const firstUserText = getFirstUserMessage(messages)
    if (!firstUserText) return ''
    return truncateTitle(firstUserText)
  }, [messages])

  const shouldGenerate = useMemo(() => {
    if (!enabled) return false
    if (!friendlyId || friendlyId === 'new') return false
    if (!sessionKey || sessionKey === 'new') return false
    if (!proposedTitle) return false
    if (!hasAssistantResponse(messages)) return false
    // Labels DERIVED from the first user message (the pre-LLM behaviour and
    // the agent's own raw naming) must not block generation — otherwise every
    // session that already shows its first message as a label is considered
    // \"titled\" and the contextual title never fires.
    const firstUserStem = proposedTitle
      .replace(/…$/, '')
      .trim()
      .toLowerCase()
    const isFirstMessageDerived = (value?: string) => {
      if (!value || !firstUserStem) return false
      const normalized = value
        .replace(/\s+/g, ' ')
        .replace(/…$/, '')
        .trim()
        .toLowerCase()
      if (!normalized) return false
      return (
        normalized.startsWith(firstUserStem.slice(0, 24)) ||
        firstUserStem.startsWith(normalized.slice(0, 24))
      )
    }
    const blocksGeneration = (value?: string) =>
      Boolean(value) &&
      !isGenericTitle(value as string) &&
      !isFirstMessageDerived(value)
    if (blocksGeneration(activeSession?.label)) return false
    if (blocksGeneration(activeSession?.title)) return false
    if (blocksGeneration(activeSession?.derivedTitle)) return false
    if (titleInfo.source === 'manual' && titleInfo.title) return false
    if (
      titleInfo.status === 'ready' &&
      titleInfo.title &&
      !isGenericTitle(titleInfo.title)
    ) {
      return false
    }
    return titleInfo.status !== 'generating'
  }, [
    activeSession?.derivedTitle,
    activeSession?.label,
    activeSession?.title,
    enabled,
    friendlyId,
    messages,
    proposedTitle,
    sessionKey,
    titleInfo.source,
    titleInfo.status,
    titleInfo.title,
  ])

  const applyTitle = (
    friendlyIdToUpdate: string,
    title: string,
    source: 'auto' | 'manual' = 'auto',
  ) => {
    updateSessionTitleState(friendlyIdToUpdate, {
      title,
      source,
      status: 'ready',
      error: null,
    })
    queryClient.setQueryData(
      chatQueryKeys.sessions,
      function updateSessions(existing: unknown) {
        if (!Array.isArray(existing)) return existing
        return existing.map((session) => {
          if (
            session &&
            typeof session === 'object' &&
            (session as SessionMeta).friendlyId === friendlyIdToUpdate
          ) {
            return {
              ...(session as SessionMeta),
              label: title,
              title,
              derivedTitle: title,
              titleStatus: 'ready',
              titleSource: source,
              titleError: null,
            }
          }
          return session
        })
      },
    )
  }

  const mutation = useMutation({
    mutationFn: async (payload: UpdateTitlePayload) => {
      const res = await fetch('/api/sessions', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionKey: payload.sessionKey,
          friendlyId: payload.friendlyId,
          label: payload.title,
        }),
      })
      if (!res.ok) {
        const message = await res.text().catch(() => 'Failed to update title')
        throw new Error(message)
      }
      return payload
    },
    onSuccess: (payload) => {
      applyTitle(payload.friendlyId, payload.title, 'auto')
      void queryClient.invalidateQueries({ queryKey: chatQueryKeys.sessions })
    },
    onError: (error, payload) => {
      updateSessionTitleState(payload.friendlyId, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error ?? ''),
      })
    },
  })

  const { mutate, isPending } = mutation

  useEffect(() => {
    if (!shouldGenerate) return
    if (isPending) return
    const signature = `${sessionKey}:${proposedTitle}`
    if (lastAttemptRef.current[friendlyId] === signature) return
    lastAttemptRef.current[friendlyId] = signature
    updateSessionTitleState(friendlyId, { status: 'generating', error: null })
    // Ask the model for a SHORT contextual title (the agent's TUI gets these
    // from its title_generation aux task; api_server sessions never did).
    // Falls back to the truncated first user message when generation fails.
    const firstUser = getFirstUserMessage(messages)
    const firstAssistantMsg = messages.find(
      (message) =>
        message.role === 'assistant' &&
        textFromMessage(message).trim().length > 0,
    )
    const firstAssistant = firstAssistantMsg
      ? textFromMessage(firstAssistantMsg).trim().slice(0, 800)
      : ''
    void (async () => {
      let title = proposedTitle
      try {
        const res = await fetch('/api/session-title', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            firstUser: firstUser.slice(0, 800),
            firstAssistant,
          }),
        })
        if (res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            title?: string
          }
          if (data.title && data.title.trim()) {
            title = truncateTitle(data.title)
          }
        }
      } catch {
        // keep the fallback title
      }
      mutate({
        friendlyId,
        sessionKey: sessionKey ?? friendlyId,
        title,
      })
    })()
  }, [
    friendlyId,
    isPending,
    messages,
    mutate,
    proposedTitle,
    sessionKey,
    shouldGenerate,
  ])
}
