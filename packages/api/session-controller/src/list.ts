/** Cold-safe Session list and search projection. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import {
  SessionQueryError,
  type SessionResultFilter,
  type SessionSearchCursor,
} from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './types.ts'
import type {
  SessionListMetadata, SessionProjectionHints, SessionProjectionValues, SessionSearchItem,
  SessionSearchRequest, SessionSearchValue, SessionSummary,
} from './types.ts'

const COLD_SUMMARY_BATCH_SIZE = 16
const SEARCH_PROVIDER_CALL_LIMIT = 100
const SESSION_SEARCH_QUERY_MAX_CHARS = 500
type MessageSearchType = Extract<SessionSearchItem['match'], { kind: 'message' }>['type']
const MESSAGE_TYPES = new Set<MessageSearchType>([
  'user/message',
  'assistant/message',
])

const sessionListMetadataSchema: z.ZodType<SessionListMetadata> = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable(),
})

const imageLimitsSchema = z.object({
  maxImageBytes: z.number().int().positive(),
  maxImagesPerMessage: z.number().int().positive(),
  maxMessageImageBytes: z.number().int().positive(),
  maxImagePixels: z.number().int().positive(),
  maxImageDimension: z.number().int().positive(),
  mediaTypes: z.array(z.string()),
}) as unknown as z.ZodType<ImageAttachmentLimits>

/**
 * Advance the Session-list metadata projection by one committed event.
 * @param state - metadata before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced metadata value.
 */
export function applySessionListMetadata(
  state: SessionListMetadata,
  event: SessionEvent,
): SessionListMetadata {
  const blank = state.blank && event.type !== 'turn/start'
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/**
 * Return the longest prefix containing at most `maximum` Unicode code points.
 * @param value - source text.
 * @param maximum - maximum number of Unicode code points.
 * @returns the source text or its longest allowed prefix.
 */
export function truncateUnicodeCodePoints(value: string, maximum: number): string {
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end)
    count++
    end += codePoint.length
  }
  return value
}

/**
 * Owns list projection registration, cold summaries, and authorized search.
 *
 * A cold row is served from the projection cache unless its block lacks a declared
 * required key; that case refolds the Session exactly once and writes the result back
 * to the official cache before the row is served.
 */
export class ApiSessionList {
  private readonly requiredColdListProjectionKeys: readonly string[]

  /**
   * @param ctx - Host context carrying Session, query, persistence, and projection services.
   * @param requiredColdListProjectionKeys - projection keys whose absence requires an exact cold refold.
   */
  constructor(
    private readonly ctx: Context,
    requiredColdListProjectionKeys: readonly string[],
  ) {
    this.requiredColdListProjectionKeys = validateRequiredColdListProjectionKeys(
      requiredColdListProjectionKeys,
    )
    ctx.sessionProjections.register<'sessionListMetadata', SessionListMetadata>({
      key: 'sessionListMetadata',
      stateSchema: sessionListMetadataSchema,
      init: () => ({ blank: true, lastPromptAt: null }),
      apply: applySessionListMetadata,
      wire: { viewSchema: sessionListMetadataSchema, view: state => state },
      stateVersion: 1,
    })
    ctx.inject(['attachments'], (attachmentCtx) => {
      ctx.sessionProjections.register<'imageLimits', null>({
        key: 'imageLimits',
        stateSchema: z.null(),
        init: () => null,
        apply: state => state,
        wire: {
          viewSchema: imageLimitsSchema,
          view: () => attachmentCtx.attachments.imageLimits,
        },
        stateVersion: 1,
      })
    })
  }

  /**
   * Build one current attached-Session summary.
   * @param session - attached Session to summarize.
   * @returns current list metadata and available projections.
   */
  summaryFor(session: Session): SessionSummary {
    const projections = this.projectionsFor(session.header, session)
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: session.id,
      updatedAt: updatedAt(session.header, metadata),
      running: this.ctx.agents.get(session.id)?.status === 'running',
      blank: metadata?.blank ?? session.seq === 0,
      ...listFields(session.header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  /**
   * Read every visible attached and persisted Session without activating an Agent.
   * @param signal - optional cancellation for persistence reads.
   * @returns visible Session summaries ordered by activity.
   */
  async list(signal?: AbortSignal): Promise<SessionSummary[]> {
    signal?.throwIfAborted()
    const records = await this.ctx.sessionQuery.listSessions(signal)
    signal?.throwIfAborted()
    const items: SessionSummary[] = []
    const cold: SessionHeader[] = []
    for (const record of records) {
      const live = this.ctx.sessions.get(record.header.id)
      if (live !== undefined) {
        items.push(this.summaryFor(live))
        continue
      }
      if (record.header.cwd === undefined) continue
      cold.push(record.header)
    }
    for (let offset = 0; offset < cold.length; offset += COLD_SUMMARY_BATCH_SIZE) {
      const settled = await Promise.allSettled(cold.slice(offset, offset + COLD_SUMMARY_BATCH_SIZE)
        .map(header => this.summarizeCold(header, signal)))
      for (const result of settled) {
        if (result.status === 'rejected') throw result.reason
        items.push(result.value)
      }
    }
    items.sort((left, right) => right.updatedAt - left.updatedAt)
    return items
  }

  /**
   * Summarize one cold Session, refolding it exactly when its cached column lacks a declared key.
   * @param header - persisted Session header.
   * @param signal - optional cancellation for the refold read.
   * @returns the row served for this cold Session.
   */
  private async summarizeCold(
    header: SessionHeader,
    signal: AbortSignal | undefined,
  ): Promise<SessionSummary> {
    const cached = this.projectionsFor(header, undefined)
    const projections = this.hasRequiredColdListProjections(cached)
      ? cached
      : await this.readRequiredColdListProjections(header, signal)
    const raced = this.ctx.sessions.get(header.id)
    if (raced !== undefined) return this.summaryFor(raced)
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: header.id,
      updatedAt: updatedAt(header, metadata),
      running: false,
      // A metadata-less or inaccessible cache miss remains unknown and visible.
      blank: metadata?.blank ?? false,
      ...listFields(header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  private hasRequiredColdListProjections(
    projections: SessionProjectionHints | undefined,
  ): boolean {
    return this.requiredColdListProjectionKeys.every(key =>
      projections !== undefined && Object.hasOwn(projections.values, key))
  }

  private async readRequiredColdListProjections(
    header: SessionHeader,
    signal: AbortSignal | undefined,
  ): Promise<SessionProjectionHints> {
    using observation = await this.ctx.sessionQuery.observeSession(header.id, {
      ...(signal === undefined ? {} : { signal }),
      projectionMode: 'all',
    })
    signal?.throwIfAborted()
    const observed = observation.source === 'prepared'
      ? this.ctx.get('sessionProjectionCache')?.coldSnapshot(
        observation.header,
        observation.inheritedEventCount,
        observation.events,
      ) ?? observation.projections
      : observation.projections
    signal?.throwIfAborted()
    const missing = this.requiredColdListProjectionKeys.filter(key =>
      observed === undefined || !Object.hasOwn(observed.values, key))
    if (observed === undefined || missing.length > 0) {
      throw new Error(
        `api-session.list: exact projection observation for ${JSON.stringify(header.id)} `
        + `did not provide required keys ${JSON.stringify(missing)}`,
      )
    }
    return {
      asOfSeq: observed.asOfSeq,
      values: observed.values as SessionProjectionValues,
    }
  }

  /**
   * Search current visible titles and message content without activating any matching Session.
   * @param request - literal title-or-message query and authorized Session predicates.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  async search(request: SessionSearchRequest, signal: AbortSignal): Promise<SessionSearchValue> {
    const normalizedQuery = normalizeSearchQuery(request.query)
    const sessionFilters: readonly SessionResultFilter[] = request.sessionIds === undefined
      ? []
      : [{ kind: 'id', values: request.sessionIds }]
    signal.throwIfAborted()
    const provider = this.ctx.get('sessionQuery')
    if (provider === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query',
        {},
      )
    }
    try {
      const visible = await provider.filterSessions(sessionFilters, signal)
      signal.throwIfAborted()
      const visibleHeaders = visible
        .map(record => record.header)
        .filter(header => header.cwd !== undefined)
      const visibleIds = new Set(visibleHeaders.map(header => header.id))
      if (visibleIds.size === 0) return { items: [], hasMore: false, coverage: 'complete', unsupported_sessions: [] }
      const titleCandidates: { readonly item: SessionSearchItem; readonly updatedAt: number }[] = []
      for (const header of visibleHeaders) {
        const projections = this.projectionsFor(header, this.ctx.sessions.get(header.id))
        if (projections === undefined) continue
        const title = projections.values.title
        if (typeof title !== 'string' || !matchesLiteralPhrase(title, normalizedQuery)) continue
        titleCandidates.push({
          item: {
            sessionId: header.id,
            snippet: truncateUnicodeCodePoints(title, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
            match: { kind: 'title', projectionAsOfSeq: projections.asOfSeq },
          },
          updatedAt: updatedAt(header, projections.values.sessionListMetadata),
        })
      }
      titleCandidates.sort((left, right) => right.updatedAt - left.updatedAt)
      const titleMatches = titleCandidates
        .slice(0, SESSION_SEARCH_RESULT_LIMIT + 1)
        .map(candidate => candidate.item)
      const authorized = [...titleMatches]
      const acceptedIds = new Set<SessionId>(titleMatches.map(item => item.sessionId))
      let coverage: SessionSearchValue['coverage'] = 'complete'
      let unsupported: SessionSearchValue['unsupported_sessions'] = []
      const seenCursors = new Set<SessionSearchCursor>()
      let cursor: SessionSearchCursor | undefined
      let providerCalls = 0
      let pageLimit = SESSION_SEARCH_RESULT_LIMIT
      while (providerCalls === 0 || authorized.length <= SESSION_SEARCH_RESULT_LIMIT) {
        signal.throwIfAborted()
        if (providerCalls >= SEARCH_PROVIDER_CALL_LIMIT) {
          throw new Error(`session search provider exceeded the ${SEARCH_PROVIDER_CALL_LIMIT}-call work budget`)
        }
        providerCalls++
        const requestedCursor = cursor
        const requestedLimit = pageLimit
        let page
        try {
          page = await provider.searchSessions({
            query: normalizedQuery,
            ...(request.sessionIds === undefined ? {} : { sessionFilters }),
            eventFilters: [
              { kind: 'type', values: ['user/message', 'assistant/message'] },
              { kind: 'surface', values: ['current'] },
            ],
            limit: requestedLimit,
            ...(requestedCursor === undefined ? {} : { cursor: requestedCursor }),
          }, { signal })
          signal.throwIfAborted()
        } catch (error: unknown) {
          signal.throwIfAborted()
          if (requestedCursor === undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_INVALID_LIMIT'
            && requestedLimit > 1) {
            pageLimit = Math.max(1, Math.floor(requestedLimit / 2))
            continue
          }
          if (requestedCursor !== undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_STALE_CURSOR') {
            authorized.length = 0
            authorized.push(...titleMatches)
            acceptedIds.clear()
            for (const item of titleMatches) acceptedIds.add(item.sessionId)
            seenCursors.clear()
            cursor = undefined
            continue
          }
          throw error
        }
        coverage = page.coverage
        unsupported = page.unsupported_sessions.filter(item => visibleIds.has(item.sessionId))
        if (page.items.length > requestedLimit) {
          throw new Error(`session search provider returned ${String(page.items.length)} items; maximum is ${String(requestedLimit)}`)
        }
        for (const hit of page.items) {
          if (authorized.length > SESSION_SEARCH_RESULT_LIMIT) continue
          if (!visibleIds.has(hit.header.id)
            || hit.bestMatch.sessionId !== hit.header.id
            || hit.bestMatch.surface !== 'current'
            || !isMessageType(hit.bestMatch.type)
            || acceptedIds.has(hit.header.id)) continue
          acceptedIds.add(hit.header.id)
          authorized.push({
            sessionId: hit.header.id,
            snippet: truncateUnicodeCodePoints(hit.bestMatch.snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
            match: { kind: 'message', seq: hit.bestMatch.seq, type: hit.bestMatch.type },
          })
        }
        if (page.nextCursor !== undefined) {
          if (seenCursors.has(page.nextCursor)) {
            throw new Error('session search provider repeated a continuation cursor')
          }
          seenCursors.add(page.nextCursor)
        }
        if (authorized.length > SESSION_SEARCH_RESULT_LIMIT || page.nextCursor === undefined) break
        cursor = page.nextCursor
      }
      return {
        items: authorized.slice(0, SESSION_SEARCH_RESULT_LIMIT),
        hasMore: authorized.length > SESSION_SEARCH_RESULT_LIMIT,
        coverage,
        unsupported_sessions: unsupported,
      }
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED') {
        throw new RemoteError('gateway/cancelled', 'session search was aborted', {})
      }
      throw new RemoteError('gateway/internal', `session search failed: ${String(error)}`, {})
    }
  }

  private projectionsFor(
    header: SessionHeader,
    session: Session | undefined,
  ): SessionProjectionHints | undefined {
    try {
      const cache = this.ctx.get('sessionProjectionCache')
      const block = session === undefined
        ? header.isSeeded
          ? undefined
          : cache?.cachedSnapshot(header, SessionLogOffset(0))
            ?? cache?.cachedPredecessorTitle(header, SessionLogOffset(0))
        : this.ctx.sessionProjections.cachedSnapshot(session)
      return block !== undefined && Object.keys(block.values).length > 0
        ? {
          asOfSeq: block.asOfSeq,
          // Listing hints contain every currently cached wire value but remain
          // partial: missing cells and cache rows are never materialized here.
          values: block.values as SessionProjectionValues,
        }
        : undefined
    } catch (error) {
      this.ctx.logger.warn(
        `api-session.list: projection column for "${header.id}" failed; serving the row without it: ${String(error)}`,
      )
      return undefined
    }
  }
}

function validateRequiredColdListProjectionKeys(keys: readonly string[]): readonly string[] {
  const unique = new Set<string>()
  for (const key of keys) {
    if (key.length === 0) {
      throw new Error('api-session.list: required cold-list projection keys must not be empty')
    }
    if (unique.has(key)) {
      throw new Error(`api-session.list: duplicate required cold-list projection key ${JSON.stringify(key)}`)
    }
    unique.add(key)
  }
  return Object.freeze([...unique])
}

function normalizeSearchQuery(query: string): string {
  const normalized = query.trim()
  if (normalized.length === 0) {
    throw new RemoteError('gateway/bad-request', 'session search query must not be empty', {})
  }
  if (normalized.length > SESSION_SEARCH_QUERY_MAX_CHARS) {
    throw new RemoteError(
      'gateway/bad-request',
      `session search query must contain at most ${SESSION_SEARCH_QUERY_MAX_CHARS} UTF-16 code units`,
      {},
    )
  }
  if (normalized.includes('\0')) {
    throw new RemoteError('gateway/bad-request', 'session search query must not contain NUL', {})
  }
  return normalized
}

function matchesLiteralPhrase(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.toLowerCase())
}

function isMessageType(value: string): value is MessageSearchType {
  return MESSAGE_TYPES.has(value as MessageSearchType)
}

function updatedAt(header: SessionHeader, metadata: SessionListMetadata | undefined): number {
  return Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)
}

function listFields(header: SessionHeader): {
  readonly parentSessionId?: SessionId
  readonly origin?: 'subagent'
  readonly cwd?: string
} {
  return {
    ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
  }
}
