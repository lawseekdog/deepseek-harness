/**
 * Session Controller search projection: list-equivalent visibility, fixed message
 * filters and result bound, cancellation mapping, and unavailable/failure
 * behavior.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import {
  SessionQueryEngine,
  SessionQueryError,
  type SessionSearchHit,
  type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import { createSessionTestRemote, testSessionPersistence } from './test-remote.ts'
import { ApiSessionList } from '../src/list.ts'

const sid = (value: string): SessionId => value as SessionId
const defaults = { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }
const titleConfig = { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 }

function request(query: string): { query: string } {
  return { query }
}

function header(id: string, cwd: string | null = '/project', createdAt = 100): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: sid(id),
    createdAt,
    isSeeded: false,
    ...(cwd === null ? {} : { cwd }),
  }
}

function hit(id: string, index = 0): SessionSearchHit {
  const session = header(id)
  return {
    header: session,
    live: true,
    persisted: false,
    bestMatch: {
      sessionId: session.id,
      seq: SessionSeq(index),
      type: 'user/message',
      time: 200 + index,
      surface: 'current',
      snippet: `match ${index}`,
    },
  }
}

function messageItem(
  id: string,
  index = 0,
  snippet = `match ${index}`,
  type: 'user/message' | 'assistant/message' = 'user/message',
) {
  return {
    sessionId: sid(id),
    snippet,
    match: { kind: 'message' as const, seq: SessionSeq(index), type },
  }
}

async function baseContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  return ctx
}

/** Real query core with a programmable full-text provider for Host search tests. */
class SearchSessionQuery extends SessionQueryEngine {
  constructor(
    ctx: Context,
    private readonly search: (
      ...args: Parameters<SessionQueryEngine['searchSessions']>
    ) => Promise<unknown>,
  ) {
    super(ctx)
  }

  override searchSessions(
    ...args: Parameters<SessionQueryEngine['searchSessions']>
  ): ReturnType<SessionQueryEngine['searchSessions']> {
    return this.search(...args) as ReturnType<SessionQueryEngine['searchSessions']>
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

function installSearchQuery(
  ctx: Context,
  searchSessions: (
    ...args: Parameters<SessionQueryEngine['searchSessions']>
  ) => Promise<unknown>,
): void {
  new SearchSessionQuery(ctx, searchSessions)
}

describe('session.search', () => {
  it('rejects search when the query service is absent', async () => {
    const ctx = await baseContext()
    const list = new ApiSessionList(ctx, [])

    await expect(list.search(request('query'), new AbortController().signal)).rejects.toMatchObject({
      code: 'gateway/internal',
    })
    await ctx.fiber.dispose()
  })

  it('searches only list-visible ids and current conversation-message events', async () => {
    const ctx = await baseContext()
    const live = ctx.sessions.create(sid('live'), { meta: header('live', '/live') })
    live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'live text' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const cold = header('cold', '/cold')
    const legacy = header('legacy', null)
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([cold, legacy]),
    }) as never)

    const searchSessions = vi.fn((
      _request: SessionSearchRequest,
      _exec?: { signal?: AbortSignal },
    ) => Promise.resolve({
      coverage: 'complete', unsupported_sessions: [], items: [
        {
          header: legacy,
          live: false,
          persisted: true,
          bestMatch: {
            sessionId: legacy.id,
            seq: 3,
            type: 'user/message' as const,
            time: 190,
            surface: 'current' as const,
            snippet: 'must remain hidden',
          },
        },
        {
          header: cold,
          live: false,
          persisted: true,
          bestMatch: {
            sessionId: cold.id,
            seq: 4,
            type: 'assistant/message' as const,
            time: 200,
            surface: 'current' as const,
            snippet: 'the matching answer',
          },
        },
      ],
    }))
    installSearchQuery(ctx, searchSessions)
    const remote = createSessionTestRemote(ctx, defaults)
    const signal = new AbortController().signal

    const response = await remote.search(request('  matching answer  '), signal)

    expect(response).toEqual({
      ok: true,
      value: {
        coverage: 'complete', unsupported_sessions: [], items: [messageItem('cold', 4, 'the matching answer', 'assistant/message')],
        hasMore: false,
      },
    })
    expect(searchSessions).toHaveBeenCalledOnce()
    const [query, exec] = searchSessions.mock.calls[0] as unknown as [
      SessionSearchRequest,
      { signal: AbortSignal },
    ]
    expect(query).toEqual({
      query: 'matching answer',
      eventFilters: [
        {
          kind: 'type',
          values: ['user/message', 'assistant/message'],
        },
        { kind: 'surface', values: ['current'] },
      ],
      limit: 20,
    })
    expect(exec.signal).toBe(signal)
  })

  it('matches a Chinese current title whose conversation messages do not contain the query', async () => {
    const ctx = await baseContext()
    await ctx.plugin(SessionTitleService, titleConfig)
    const session = ctx.sessions.create(sid('title-only'), { meta: header('title-only') })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '请分析上传的材料' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const title = ctx.sessionTitle.rename(session, '新咨询')
    const searchSessions = vi.fn(() => Promise.resolve({
      coverage: 'complete' as const, unsupported_sessions: [], items: [],
    }))
    installSearchQuery(ctx, searchSessions)

    await expect(new ApiSessionList(ctx, []).search(request('新咨询'), new AbortController().signal)).resolves.toEqual({
      coverage: 'complete',
      unsupported_sessions: [],
      items: [{
        sessionId: sid('title-only'),
        snippet: '新咨询',
        match: { kind: 'title', projectionAsOfSeq: title.eventSeq },
      }],
      hasMore: false,
    })
    expect(searchSessions).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('returns one title result when the same Session title and message both match', async () => {
    const ctx = await baseContext()
    await ctx.plugin(SessionTitleService, titleConfig)
    const session = ctx.sessions.create(sid('title-and-message'), { meta: header('title-and-message') })
    ctx.sessionTitle.rename(session, '合同审查')
    installSearchQuery(ctx, () => Promise.resolve({
      coverage: 'complete', unsupported_sessions: [], items: [hit('title-and-message', 7)],
    }))

    const result = await new ApiSessionList(ctx, []).search(request('合同审查'), new AbortController().signal)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      sessionId: sid('title-and-message'),
      snippet: '合同审查',
      match: { kind: 'title' },
    })
    await ctx.fiber.dispose()
  })

  it('searches only the latest title after an explicit rename', async () => {
    const ctx = await baseContext()
    await ctx.plugin(SessionTitleService, titleConfig)
    const session = ctx.sessions.create(sid('renamed-title'), { meta: header('renamed-title') })
    ctx.sessionTitle.rename(session, '旧标题')
    const current = ctx.sessionTitle.rename(session, '当前标题')
    installSearchQuery(ctx, () => Promise.resolve({ coverage: 'complete', unsupported_sessions: [], items: [] }))
    const list = new ApiSessionList(ctx, [])

    await expect(list.search(request('旧标题'), new AbortController().signal)).resolves.toMatchObject({ items: [] })
    await expect(list.search(request('当前标题'), new AbortController().signal)).resolves.toMatchObject({
      items: [{
        sessionId: sid('renamed-title'),
        snippet: '当前标题',
        match: { kind: 'title', projectionAsOfSeq: current.eventSeq },
      }],
    })
    await ctx.fiber.dispose()
  })

  it('applies one Session scope before title collection and on every message page', async () => {
    const ctx = await baseContext()
    await ctx.plugin(SessionTitleService, titleConfig)
    for (let index = 0; index < 21; index++) {
      const external = ctx.sessions.create(sid(`external-${index}`), {
        meta: header(`external-${index}`, `/external-${index}`),
      })
      ctx.sessionTitle.rename(external, `范围查询 ${index}`)
    }
    const own = ctx.sessions.create(sid('own-message'), { meta: header('own-message', '/own') })
    const sessionIds = [own.id]
    const sessionFilters = [{ kind: 'id' as const, values: sessionIds }]
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({
        coverage: 'complete', unsupported_sessions: [], items: [], nextCursor: 'own-page',
      })
      .mockResolvedValueOnce({
        coverage: 'complete', unsupported_sessions: [], items: [hit('own-message')],
      })
    installSearchQuery(ctx, searchSessions)
    const filterSessions = vi.spyOn(ctx.sessionQuery, 'filterSessions')
    const signal = new AbortController().signal

    await expect(createSessionTestRemote(ctx, defaults).search({
      query: '范围查询',
      sessionIds,
    }, signal)).resolves.toEqual({
      ok: true,
      value: {
        coverage: 'complete',
        unsupported_sessions: [],
        items: [messageItem('own-message')],
        hasMore: false,
      },
    })
    expect(filterSessions).toHaveBeenCalledWith(sessionFilters, signal)
    expect(searchSessions).toHaveBeenCalledTimes(2)
    for (const call of searchSessions.mock.calls) {
      expect(call[0]).toMatchObject({ sessionFilters })
    }
    await ctx.fiber.dispose()
  })

  it('treats an empty id scope as no visible Sessions', async () => {
    const ctx = await baseContext()
    await ctx.plugin(SessionTitleService, titleConfig)
    const visible = ctx.sessions.create(sid('visible'), { meta: header('visible') })
    ctx.sessionTitle.rename(visible, '范围查询')
    const searchSessions = vi.fn(() => Promise.resolve({
      coverage: 'complete', unsupported_sessions: [], items: [hit('visible')],
    }))
    installSearchQuery(ctx, searchSessions)
    const sessionIds: SessionId[] = []

    await expect(createSessionTestRemote(ctx, defaults).search({
      query: '范围查询',
      sessionIds,
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: {
        coverage: 'complete', unsupported_sessions: [], items: [], hasMore: false,
      },
    })
    expect(searchSessions).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('orders matching titles by recent prompt activity', async () => {
    const ctx = await baseContext()
    await ctx.plugin(SessionTitleService, titleConfig)
    const list = new ApiSessionList(ctx, [])
    const recentlyActive = ctx.sessions.create(sid('old-recently-active'), {
      meta: header('old-recently-active', '/old', 100),
    })
    recentlyActive.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unrelated recent prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    ctx.sessionTitle.rename(recentlyActive, '共同标题 旧会话')
    const newlyCreated = ctx.sessions.create(sid('new-idle'), {
      meta: header('new-idle', '/new', 1_000),
    })
    ctx.sessionTitle.rename(newlyCreated, '共同标题 新会话')
    installSearchQuery(ctx, () => Promise.resolve({
      coverage: 'complete', unsupported_sessions: [], items: [],
    }))

    const result = await list.search(
      request('共同标题'),
      new AbortController().signal,
    )
    expect(result.items.map(item => item.sessionId)).toEqual([
      sid('old-recently-active'),
      sid('new-idle'),
    ])
    await ctx.fiber.dispose()
  })

  it('continues message pages past title duplicates to preserve the unified result bound', async () => {
    const ctx = await baseContext()
    await ctx.plugin(SessionTitleService, titleConfig)
    const titled = Array.from({ length: 20 }, (_, index) => {
      const id = `title-${index}`
      const session = ctx.sessions.create(sid(id), { meta: header(id) })
      ctx.sessionTitle.rename(session, `统一检索 ${index}`)
      return hit(id, index)
    })
    const additional = hit('message-only', 20)
    ctx.sessions.create(additional.header.id, { meta: additional.header })
    ctx.sessions.create(sid('unsupported-other'), { meta: header('unsupported-other') })
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({
        coverage: 'incomplete',
        unsupported_sessions: [{ sessionId: sid('unsupported-other'), reason: 'SESSION_FORMAT_UNSUPPORTED' }],
        items: titled,
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        coverage: 'incomplete',
        unsupported_sessions: [{ sessionId: sid('unsupported-other'), reason: 'SESSION_FORMAT_UNSUPPORTED' }],
        items: [additional],
      })
    installSearchQuery(ctx, searchSessions)

    const result = await new ApiSessionList(ctx, []).search(request('统一检索'), new AbortController().signal)
    expect(result.items).toHaveLength(20)
    expect(new Set(result.items.map(item => item.sessionId)).size).toBe(20)
    expect(result.hasMore).toBe(true)
    expect(result.coverage).toBe('incomplete')
    expect(result.unsupported_sessions).toEqual([
      { sessionId: sid('unsupported-other'), reason: 'SESSION_FORMAT_UNSUPPORTED' },
    ])
    expect(searchSessions).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('rejects invalid wire queries before invoking the search provider', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const searchSessions = vi.fn()
    installSearchQuery(ctx, searchSessions)
    const remote = createSessionTestRemote(ctx, defaults)

    for (const query of ['', '   ', 'contains\0nul', 'x'.repeat(501)]) {
      await expect(remote.search(request(query), new AbortController().signal))
        .resolves.toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
    }
    expect(searchSessions).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('returns an empty page without invoking the index when no session is visible', async () => {
    const ctx = await baseContext()
    const searchSessions = vi.fn()
    installSearchQuery(ctx, searchSessions)
    const remote = createSessionTestRemote(ctx, defaults)

    const response = await remote.search(
      request('anything'),
      new AbortController().signal,
    )

    expect(response).toEqual({
      ok: true,
      value: { coverage: 'complete', unsupported_sessions: [], items: [], hasMore: false },
    })
    expect(searchSessions).not.toHaveBeenCalled()
  })

  it('rejects snippets whose recorded provider violates the Host filters', async () => {
    const ctx = await baseContext()
    const visible = hit('visible')
    ctx.sessions.create(visible.header.id, { meta: visible.header })
    const withBestMatch = (
      index: number,
      bestMatch: Partial<SessionSearchHit['bestMatch']>,
    ): SessionSearchHit => {
      const base = hit('visible', index)
      return { ...base, bestMatch: { ...base.bestMatch, ...bestMatch } }
    }
    installSearchQuery(ctx, () => Promise.resolve({
      coverage: 'complete', unsupported_sessions: [], items: [
        withBestMatch(0, { sessionId: sid('hidden') }),
        withBestMatch(1, { surface: 'shadowed' }),
        withBestMatch(2, { type: 'tool/result' }),
        withBestMatch(3, { type: 'user/message', snippet: 'allowed snippet' }),
      ],
    }))

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('match'),
      new AbortController().signal,
    )

    expect(response).toEqual({
      ok: true,
      value: {
        coverage: 'complete', unsupported_sessions: [], items: [messageItem('visible', 3, 'allowed snippet')],
        hasMore: false,
      },
    })
  })

  it('pages the globally ranked stream until the 20-item Host boundary is known', async () => {
    const ctx = await baseContext()
    const items = Array.from({ length: 22 }, (_, index) => hit(`visible-${index}`, index))
    for (const item of items) {
      ctx.sessions.create(item.header.id, { meta: item.header })
    }
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({
        coverage: 'complete', unsupported_sessions: [], items: [hit('hidden-ranked-first'), ...items.slice(0, 19)],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({ coverage: 'complete', unsupported_sessions: [], items: items.slice(19) })
    installSearchQuery(ctx, searchSessions)
    const response = await createSessionTestRemote(ctx, defaults).search(
      request('match'),
      new AbortController().signal,
    )

    expect(response).toMatchObject({
      ok: true,
      value: { hasMore: true },
    })
    if (!response.ok) throw new Error('unreachable')
    expect(response.value.items).toHaveLength(20)
    expect(response.value.items.at(-1)?.sessionId).toBe('visible-19')
    expect(searchSessions).toHaveBeenCalledTimes(2)
    expect(searchSessions.mock.calls[1]?.[0]).toMatchObject({ cursor: 'page-2' })
  })

  it('learns a provider maxLimit of 10 and collects the 20-item result plus lookahead', async () => {
    const ctx = await baseContext()
    const items = Array.from({ length: 21 }, (_, index) => hit(`visible-${index}`, index))
    for (const item of items) {
      ctx.sessions.create(item.header.id, { meta: item.header })
    }
    const invalidLimit = new SessionQueryError(
      'provider accepts at most 10 items',
      'SESSION_QUERY_INVALID_LIMIT',
    )
    const searchSessions = vi.fn((providerRequest: SessionSearchRequest) => {
      const limit = providerRequest.limit
      if (limit === undefined) throw new Error('Host search must request an explicit provider limit')
      if (limit > 10) return Promise.reject(invalidLimit)
      const offset = providerRequest.cursor === undefined
        ? 0
        : Number.parseInt(providerRequest.cursor.slice('offset-'.length), 10)
      const end = Math.min(items.length, offset + limit)
      return Promise.resolve({
        coverage: 'complete', unsupported_sessions: [], items: items.slice(offset, end),
        ...end < items.length ? { nextCursor: `offset-${end}` } : {},
      })
    })
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('adaptive-page-limit'),
      new AbortController().signal,
    )

    expect(response).toMatchObject({
      ok: true,
      value: { hasMore: true },
    })
    if (!response.ok) throw new Error('unreachable')
    expect(response.value.items.map(item => item.sessionId))
      .toEqual(items.slice(0, 20).map(item => item.header.id))
    expect(searchSessions.mock.calls.map(([providerRequest]) => ({
      limit: providerRequest.limit,
      cursor: providerRequest.cursor,
    }))).toEqual([
      { limit: 20, cursor: undefined },
      { limit: 10, cursor: undefined },
      { limit: 10, cursor: 'offset-10' },
      { limit: 10, cursor: 'offset-20' },
    ])
  })

  it('counts a page-limit probe inside the 100-call budget', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const invalidLimit = new SessionQueryError(
      'provider accepts at most 10 items',
      'SESSION_QUERY_INVALID_LIMIT',
    )
    const searchSessions = vi.fn((providerRequest: SessionSearchRequest) => {
      if (searchSessions.mock.calls.length === 1) {
        expect(providerRequest).toMatchObject({ limit: 20 })
        return Promise.reject(invalidLimit)
      }
      expect(providerRequest.limit).toBe(10)
      return Promise.resolve({
        coverage: 'complete', unsupported_sessions: [], items: [],
        nextCursor: `page-${searchSessions.mock.calls.length}`,
      })
    })
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('endless-pages'),
      new AbortController().signal,
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error('unreachable')
    expect(response.error).toMatchObject({ code: 'gateway/internal' })
    expect(response.error.message).toContain('100-call work budget')
    expect(searchSessions).toHaveBeenCalledTimes(100)
  })

  it('restarts a stale continuation with its learned limit and original visibility snapshot', async () => {
    const ctx = await baseContext()
    const oldOnly = hit('old-only', 0)
    const shared = hit('shared', 1)
    const freshFirst = hit('fresh-first', 2)
    const freshLast = hit('fresh-last', 3)
    for (const item of [oldOnly, shared, freshFirst, freshLast]) {
      ctx.sessions.create(item.header.id, { meta: item.header })
    }
    const late = hit('late-visible', 4)
    const stale = new SessionQueryError(
      'provider generation changed',
      'SESSION_QUERY_STALE_CURSOR',
    )
    const invalidLimit = new SessionQueryError(
      'provider accepts at most 10 items',
      'SESSION_QUERY_INVALID_LIMIT',
    )
    const searchSessions = vi.fn((providerRequest: SessionSearchRequest) => {
      switch (searchSessions.mock.calls.length) {
        case 1:
          expect(providerRequest).toMatchObject({ limit: 20 })
          expect(providerRequest).not.toHaveProperty('cursor')
          return Promise.reject(invalidLimit)
        case 2:
          expect(providerRequest).toMatchObject({ limit: 10 })
          expect(providerRequest).not.toHaveProperty('cursor')
          return Promise.resolve({
            coverage: 'complete', unsupported_sessions: [], items: [oldOnly, shared],
            nextCursor: 'old-cursor',
          })
        case 3:
          expect(providerRequest).toMatchObject({ limit: 10 })
          expect(providerRequest.cursor).toBe('old-cursor')
          ctx.sessions.create(late.header.id, { meta: late.header })
          return Promise.reject(stale)
        case 4:
          expect(providerRequest).toMatchObject({ limit: 10 })
          expect(providerRequest).not.toHaveProperty('cursor')
          return Promise.resolve({
            coverage: 'complete', unsupported_sessions: [], items: [freshFirst, shared],
            nextCursor: 'old-cursor',
          })
        case 5:
          expect(providerRequest).toMatchObject({ limit: 10 })
          expect(providerRequest.cursor).toBe('old-cursor')
          return Promise.resolve({ coverage: 'complete', unsupported_sessions: [], items: [freshLast, late] })
        default:
          return Promise.reject(new Error('unexpected provider call'))
      }
    })
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('stale-restart'),
      new AbortController().signal,
    )

    expect(response).toEqual({
      ok: true,
      value: {
        coverage: 'complete', unsupported_sessions: [], items: [
          messageItem('fresh-first', 2),
          messageItem('shared', 1),
          messageItem('fresh-last', 3),
        ],
        hasMore: false,
      },
    })
    expect(searchSessions).toHaveBeenCalledTimes(5)
  })

  it('counts continuous stale restarts against the 100-call budget', async () => {
    const ctx = await baseContext()
    const partial = hit('partial')
    ctx.sessions.create(partial.header.id, { meta: partial.header })
    const stale = new SessionQueryError(
      'provider generation changed',
      'SESSION_QUERY_STALE_CURSOR',
    )
    const searchSessions = vi.fn((providerRequest: SessionSearchRequest) => {
      if (searchSessions.mock.calls.length > 100) {
        return Promise.reject(new Error('provider was called after the shared budget'))
      }
      if (providerRequest.cursor !== undefined) return Promise.reject(stale)
      return Promise.resolve({
        coverage: 'complete', unsupported_sessions: [], items: [partial],
        nextCursor: `cursor-${searchSessions.mock.calls.length}`,
      })
    })
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('stale-churn'),
      new AbortController().signal,
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error('unreachable')
    expect(response.error.code).toBe('gateway/internal')
    expect(response.error.message).toContain('100-call work budget')
    expect(response).not.toHaveProperty('value')
    expect(searchSessions).toHaveBeenCalledTimes(100)
  })

  it('gives abort priority over a coincident stale continuation failure', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const controller = new AbortController()
    const stale = new SessionQueryError(
      'provider generation changed',
      'SESSION_QUERY_STALE_CURSOR',
    )
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({ coverage: 'complete', unsupported_sessions: [], items: [], nextCursor: 'stale-cursor' })
      .mockImplementationOnce(() => {
        controller.abort()
        return Promise.reject(stale)
      })
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('abort-stale'),
      controller.signal,
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'gateway/cancelled' },
    })
    expect(searchSessions).toHaveBeenCalledTimes(2)
  })

  it('does not retry a stale first-page failure', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const searchSessions = vi.fn(() => Promise.reject(new SessionQueryError(
      'provider generation changed before paging',
      'SESSION_QUERY_STALE_CURSOR',
    )))
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('first-page-stale'),
      new AbortController().signal,
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'gateway/internal' },
    })
    expect(response).not.toHaveProperty('value')
    expect(searchSessions).toHaveBeenCalledOnce()
  })

  it('does not adapt an invalid-limit continuation failure', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({ coverage: 'complete', unsupported_sessions: [], items: [], nextCursor: 'page-2' })
      .mockRejectedValueOnce(new SessionQueryError(
        'continuation limit is invalid',
        'SESSION_QUERY_INVALID_LIMIT',
      ))
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('continuation-invalid-limit'),
      new AbortController().signal,
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'gateway/internal' },
    })
    expect(searchSessions).toHaveBeenCalledTimes(2)
    expect(searchSessions.mock.calls.map(([providerRequest]) => (
      providerRequest as SessionSearchRequest
    ).limit))
      .toEqual([20, 20])
  })

  it('stops page-limit adaptation at one item', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const searchSessions = vi.fn((providerRequest: SessionSearchRequest) => Promise.reject(
      new SessionQueryError(
        `provider rejects ${providerRequest.limit}`,
        'SESSION_QUERY_INVALID_LIMIT',
      ),
    ))
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('minimum-page-limit'),
      new AbortController().signal,
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'gateway/internal' },
    })
    expect(searchSessions.mock.calls.map(([providerRequest]) => providerRequest.limit))
      .toEqual([20, 10, 5, 2, 1])
  })

  it('gives abort priority over a coincident invalid first-page limit', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const controller = new AbortController()
    const searchSessions = vi.fn(() => {
      controller.abort()
      return Promise.reject(new SessionQueryError(
        'provider rejects 20',
        'SESSION_QUERY_INVALID_LIMIT',
      ))
    })
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('abort-invalid-limit'),
      controller.signal,
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'gateway/cancelled' },
    })
    expect(searchSessions).toHaveBeenCalledOnce()
  })

  it('rejects an oversized provider page', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const oversized = Array.from({ length: 21 }, (_, index) => hit(`oversized-${index}`))
    const searchSessions = vi.fn(() => Promise.resolve({ coverage: 'complete', unsupported_sessions: [], items: oversized }))
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('oversized-page'),
      new AbortController().signal,
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error('unreachable')
    expect(response.error).toMatchObject({ code: 'gateway/internal' })
    expect(response.error.message).toContain('returned 21 items; maximum is 20')
  })

  it('uses the learned provider limit for the overproduction guard', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const oversized = Array.from({ length: 11 }, (_, index) => hit(`oversized-${index}`))
    const searchSessions = vi.fn((providerRequest: SessionSearchRequest) => {
      if (providerRequest.limit === 20) {
        return Promise.reject(new SessionQueryError(
          'provider accepts at most 10 items',
          'SESSION_QUERY_INVALID_LIMIT',
        ))
      }
      return Promise.resolve({ coverage: 'complete', unsupported_sessions: [], items: oversized })
    })
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('adapted-oversized-page'),
      new AbortController().signal,
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error('unreachable')
    expect(response.error).toMatchObject({ code: 'gateway/internal' })
    expect(response.error.message).toContain('returned 11 items; maximum is 10')
    expect(searchSessions).toHaveBeenCalledTimes(2)
  })

  it('bounds provider snippets to 240 Unicode code points without splitting astral text', async () => {
    const ctx = await baseContext()
    const visible = hit('visible')
    ctx.sessions.create(visible.header.id, { meta: visible.header })
    const expected = `${'x'.repeat(239)}😀`
    const overlong = {
      ...visible,
      bestMatch: {
        ...visible.bestMatch,
        snippet: `${expected}${'y'.repeat(10_000)}`,
      },
    }
    installSearchQuery(ctx, () => Promise.resolve({ coverage: 'complete', unsupported_sessions: [], items: [overlong] }))

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('bounded-snippet'),
      new AbortController().signal,
    )

    expect(response).toEqual({
      ok: true,
      value: {
        coverage: 'complete', unsupported_sessions: [], items: [messageItem('visible', 0, expected)],
        hasMore: false,
      },
    })
  })

  it('fails closed when the provider repeats a continuation cursor', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({ coverage: 'complete', unsupported_sessions: [], items: [], nextCursor: 'repeated' })
      .mockResolvedValueOnce({ coverage: 'complete', unsupported_sessions: [], items: [], nextCursor: 'repeated' })
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('repeated-cursor'),
      new AbortController().signal,
    )

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error('unreachable')
    expect(response.error).toMatchObject({ code: 'gateway/internal' })
    expect(response.error.message).toContain('repeated a continuation cursor')
    expect(searchSessions).toHaveBeenCalledTimes(2)
  })

  it('validates a repeated cursor before accepting the authorized lookahead', async () => {
    const ctx = await baseContext()
    const items = Array.from({ length: 21 }, (_, index) => hit(`visible-${index}`, index))
    for (const item of items) {
      ctx.sessions.create(item.header.id, { meta: item.header })
    }
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({ coverage: 'complete', unsupported_sessions: [], items: items.slice(0, 20), nextCursor: 'repeated' })
      .mockResolvedValueOnce({ coverage: 'complete', unsupported_sessions: [], items: items.slice(20), nextCursor: 'repeated' })
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('repeated-lookahead-cursor'),
      new AbortController().signal,
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'gateway/internal' },
    })
    expect(response).not.toHaveProperty('value')
    if (response.ok) throw new Error('unreachable')
    expect(response.error.message).toContain('repeated a continuation cursor')
    expect(searchSessions).toHaveBeenCalledTimes(2)
  })

  it('does not count duplicate session ids toward the result or lookahead boundary', async () => {
    const ctx = await baseContext()
    const items = Array.from({ length: 21 }, (_, index) => hit(`visible-${index}`, index))
    for (const item of items) {
      ctx.sessions.create(item.header.id, { meta: item.header })
    }
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({ coverage: 'complete', unsupported_sessions: [], items: items.slice(0, 20), nextCursor: 'page-2' })
      .mockResolvedValueOnce({ coverage: 'complete', unsupported_sessions: [], items: items.slice(0, 20), nextCursor: 'page-3' })
      .mockResolvedValueOnce({ coverage: 'complete', unsupported_sessions: [], items: items.slice(20) })
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('duplicate-pages'),
      new AbortController().signal,
    )

    expect(response).toMatchObject({
      ok: true,
      value: { hasMore: true },
    })
    if (!response.ok) throw new Error('unreachable')
    expect(response.value.items.map(item => item.sessionId)).toEqual(
      items.slice(0, 20).map(item => item.header.id),
    )
    expect(searchSessions).toHaveBeenCalledTimes(3)
  })

  it('cancels on a continuation page and passes the carrier signal to both calls', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const controller = new AbortController()
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({ coverage: 'complete', unsupported_sessions: [], items: [], nextCursor: 'page-2' })
      .mockImplementationOnce(() => {
        controller.abort()
        return Promise.resolve({ coverage: 'complete', unsupported_sessions: [], items: [] })
      })
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('cancel-continuation'),
      controller.signal,
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'gateway/cancelled' },
    })
    expect(searchSessions).toHaveBeenCalledTimes(2)
    for (const call of searchSessions.mock.calls) {
      expect(call[1]).toEqual({ signal: controller.signal })
    }
  })

  it('keeps visibility sets above SQLite variable limits out of provider bindings', async () => {
    const ctx = await baseContext()
    const cold = Array.from(
      { length: 32_751 },
      (_, index) => header(`cold-${index}`, `/cold-${index}`),
    )
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve(cold),
    }) as never)
    const searchSessions = vi.fn((_request: SessionSearchRequest) => Promise.resolve({
      coverage: 'complete', unsupported_sessions: [], items: [hit('cold-32750')],
    }))
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('large corpus'),
      new AbortController().signal,
    )

    expect(response).toEqual({
      ok: true,
      value: {
        coverage: 'complete', unsupported_sessions: [], items: [messageItem('cold-32750')],
        hasMore: false,
      },
    })
    expect(searchSessions).toHaveBeenCalledOnce()
    expect(searchSessions.mock.calls[0]?.[0]).not.toHaveProperty('sessionFilters')
  })

  it('propagates cancellation through the lightweight visibility listing', async () => {
    const ctx = await baseContext()
    const controller = new AbortController()
    const cold = Array.from({ length: 32 }, (_, index) => header(`cold-${index}`, `/cold-${index}`))
    const list = vi.fn((signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal)
      controller.abort()
      return Promise.resolve(cold)
    })
    let statCalls = 0
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list,
      stat: () => {
        statCalls++
        return Promise.resolve(undefined)
      },
    }) as never)
    const searchSessions = vi.fn()
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('cancel-during-visibility'),
      controller.signal,
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'gateway/cancelled' },
    })
    expect(list).toHaveBeenCalledOnce()
    expect(statCalls).toBe(0)
    expect(searchSessions).not.toHaveBeenCalled()
  })

  it('does not stat or open cold artifacts while collecting search visibility', async () => {
    const ctx = await baseContext()
    const cold = Array.from({ length: 16 }, (_, index) => header(`cold-${index}`, `/cold-${index}`))
    const stat = vi.fn()
    const inspect = vi.fn()
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve(cold),
      stat,
      inspect,
    }) as never)
    const searchSessions = vi.fn(() => Promise.resolve({ coverage: 'complete', unsupported_sessions: [], items: [] }))
    installSearchQuery(ctx, searchSessions)

    const response = await createSessionTestRemote(ctx, defaults).search(
      request('header-only-visibility'),
      new AbortController().signal,
    )
    expect(response).toMatchObject({
      ok: true,
      value: { coverage: 'complete', unsupported_sessions: [], items: [], hasMore: false },
    })
    expect(stat).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
    expect(searchSessions).toHaveBeenCalledOnce()
  })

  it('maps preflight cancellation, query cancellation, and provider failure', async () => {
    const missingCtx = await baseContext()
    missingCtx.sessions.create(sid('visible'), { meta: header('visible') })
    const missingApi = createSessionTestRemote(missingCtx, defaults)
    const preAborted = new AbortController()
    preAborted.abort()
    const cancelledBeforeLookup = await missingApi.search(
      request('cancel-before-lookup'),
      preAborted.signal,
    )
    expect(cancelledBeforeLookup).toMatchObject({
      ok: false,
      error: { code: 'gateway/cancelled' },
    })

    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const aborted = new SessionQueryError('provider stopped', 'SESSION_QUERY_ABORTED')
    const searchSessions = vi.fn()
      .mockRejectedValueOnce(aborted)
      .mockRejectedValueOnce(new Error('database unavailable'))
    installSearchQuery(ctx, searchSessions)
    const remote = createSessionTestRemote(ctx, defaults)

    const cancelled = await remote.search(
      request('first'),
      new AbortController().signal,
    )
    expect(cancelled).toMatchObject({
      ok: false,
      error: { code: 'gateway/cancelled' },
    })

    const failed = await remote.search(
      request('second'),
      new AbortController().signal,
    )
    expect(failed.ok).toBe(false)
    if (failed.ok) throw new Error('unreachable')
    expect(failed.error.code).toBe('gateway/internal')
    expect(failed.error.message).toContain('database unavailable')
  })
})

describe('search coverage contract', () => {
  it('retains incomplete status while restricting unsupported ids to list-visible sessions', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    installSearchQuery(ctx, async () => ({
      items: [], coverage: 'incomplete', unsupported_sessions: [
        { sessionId: sid('visible'), reason: 'SESSION_FORMAT_UNSUPPORTED' },
        { sessionId: sid('hidden'), reason: 'SESSION_FORMAT_UNSUPPORTED' },
      ],
    }))
    try {
      await expect(new ApiSessionList(ctx, []).search(request('needle'), new AbortController().signal)).resolves.toEqual({
        items: [], hasMore: false, coverage: 'incomplete', unsupported_sessions: [
          { sessionId: sid('visible'), reason: 'SESSION_FORMAT_UNSUPPORTED' },
        ],
      })
    } finally { await ctx.fiber.dispose() }
  })

  it('does not invent complete coverage when all unsupported ids are outside the visible list', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    installSearchQuery(ctx, async () => ({
      items: [], coverage: 'incomplete', unsupported_sessions: [
        { sessionId: sid('hidden'), reason: 'SESSION_FORMAT_UNSUPPORTED' },
      ],
    }))
    try {
      await expect(new ApiSessionList(ctx, []).search(request('needle'), new AbortController().signal)).resolves.toEqual({
        items: [], hasMore: false, coverage: 'incomplete', unsupported_sessions: [],
      })
    } finally { await ctx.fiber.dispose() }
  })
})
