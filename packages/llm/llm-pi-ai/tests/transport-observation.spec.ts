import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { observeTransport } from '../src/transport-observation.ts'
import type { TransportObservationRecord, TransportObservationOptions } from '../src/transport-observation.ts'

const sessionId = 'session-exact' as NonNullable<GenerateOptions['sessionId']>
const request = { sessionId, provider: 'test-route', model: 'test-model' }
const sentinel = 'PRIVATE_SENTINEL_NEVER_LOG'
const enc = new TextEncoder()

function observation(emit: (record: TransportObservationRecord) => void, maxFrameBytes = 4096) {
  return observeTransport(request, 'openai-completions', {
    config: () => ({ sessionIds: [sessionId], maxFrameBytes }), emit,
  })!
}

function source(parts: Uint8Array[]) {
  let index = 0
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (index === parts.length) controller.close()
    else controller.enqueue(parts[index++]!)
  })
  const cancel = vi.fn()
  return { body: new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), pull, cancel }
}

function finalTransport(records: TransportObservationRecord[]) {
  return records.findLast(record => record.event === 'http-end')!.transport!
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Session transport observation', () => {
  it('is absent by default and leaves unselected or missing Sessions untouched', () => {
    const emit = vi.fn()
    const selected: TransportObservationOptions = { config: () => ({ sessionIds: ['session-other'], maxFrameBytes: 1024 }), emit }
    expect(observeTransport(request, 'openai-completions', undefined)).toBeUndefined()
    expect(observeTransport(request, 'openai-completions', { config: () => undefined, emit })).toBeUndefined()
    expect(observeTransport(request, 'openai-completions', { config: () => null, emit })).toBeUndefined()
    expect(observeTransport(request, 'openai-completions', selected)).toBeUndefined()
    expect(observeTransport({ provider: 'test', model: 'test' }, 'openai-completions', selected)).toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
  })

  it('reports unsupported APIs without installing fetch or changing transport', () => {
    const emit = vi.fn()
    expect(observeTransport(request, 'anthropic-messages', {
      config: () => ({ sessionIds: [sessionId], maxFrameBytes: 1024 }), emit,
    })).toBeUndefined()
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: 'unsupported-api' }))
  })

  it('forwards the same request and byte arrays on demand and preserves response metadata', async () => {
    const parts = [enc.encode('data: {"id":"chatcmpl-exact","choices":[{"delta":{"content":"你好"}}]}\r\n\r\n'),
      enc.encode('data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')]
    const stream = source(parts)
    const response = new Response(stream.body, { status: 201, statusText: 'Created', headers: { 'x-request-id': 'req-exact' } })
    Object.defineProperty(response, 'url', { value: 'https://provider.example/completions' })
    const fetch = vi.fn(async () => response)
    vi.stubGlobal('fetch', fetch)
    const records: TransportObservationRecord[] = []
    const observer = observation(record => records.push(record))
    const abort = new AbortController()
    const init = { method: 'POST', body: sentinel, signal: abort.signal, headers: { authorization: sentinel } }
    const actual = await observer.sdk.fetch!('https://provider.example/completions', init)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://provider.example/completions', init)
    expect(stream.pull).not.toHaveBeenCalled()
    expect(actual.url).toBe(response.url)
    expect(actual.status).toBe(201)
    expect(actual.statusText).toBe('Created')
    expect(actual.headers.get('x-request-id')).toBe('req-exact')
    const reader = actual.body!.getReader()
    expect((await reader.read()).value).toBe(parts[0])
    expect(stream.pull).toHaveBeenCalledTimes(1)
    expect((await reader.read()).value).toBe(parts[1])
    expect((await reader.read()).done).toBe(true)
    const summary = finalTransport(records)
    expect(summary).toMatchObject({ bytes: parts.reduce((n, part) => n + part.length, 0), frames: 3, dataFrames: 3,
      responseId: 'chatcmpl-exact', finishReason: 'stop', incompleteFrame: false })
    expect(summary.doneAt).toEqual(expect.any(Number))
    expect(summary.eofAt).toEqual(expect.any(Number))
    expect(records.find(record => record.event === 'http-response')?.requestIds).toEqual({ 'x-request-id': 'req-exact' })
    expect(JSON.stringify(records)).not.toContain(sentinel)
    expect(JSON.stringify(records)).not.toContain('你好')
  })

  it('handles split UTF-8, CRLF, multiline data and DONE without mistaking content for a terminal marker', async () => {
    const bytes = enc.encode(': heartbeat\r\n\r\ndata: {"id":"chatcmpl-split",\r\ndata: "choices":[{"delta":{"content":"你好 [DONE]"}}]}\r\n\r\ndata: [DONE]\r\n\r\n')
    const stream = source(Array.from(bytes, byte => Uint8Array.of(byte)))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream.body)))
    const records: TransportObservationRecord[] = []
    const response = await observation(record => records.push(record)).sdk.fetch!('http://fixture.test')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(finalTransport(records)).toMatchObject({ responseId: 'chatcmpl-split', commentFrames: 1, dataFrames: 2, invalidFrames: 0 })
    expect(finalTransport(records).doneAt).toEqual(expect.any(Number))
  })

  it('keeps DONE distinct from EOF when the body stays open, then propagates cancellation', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(enc.encode('data: [DONE]\n\n')) }, cancel }, { highWaterMark: 0 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    const records: TransportObservationRecord[] = []
    const observer = observation(record => records.push(record))
    const response = await observer.sdk.fetch!('http://fixture.test')
    const reader = response.body!.getReader()
    await reader.read()
    expect(records.some(record => record.event === 'http-end')).toBe(false)
    await reader.cancel(sentinel)
    expect(cancel).toHaveBeenCalledExactlyOnceWith(sentinel)
    expect(finalTransport(records).doneAt).toEqual(expect.any(Number))
    expect(finalTransport(records).cancelledAt).toEqual(expect.any(Number))
    expect(finalTransport(records).eofAt).toBeUndefined()
    expect(JSON.stringify(records)).not.toContain(sentinel)
  })

  it('records abort and the subsequent read error independently without logging the reason', async () => {
    const controller = new AbortController()
    const failure = new Error(sentinel)
    const body = new ReadableStream<Uint8Array>({ start(stream) {
      controller.signal.addEventListener('abort', () => { stream.error(failure) }, { once: true })
    } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    const records: TransportObservationRecord[] = []
    const observer = observation(record => records.push(record))
    const response = await observer.sdk.fetch!('http://fixture.test', { signal: controller.signal })
    const read = response.body!.getReader().read()
    controller.abort(sentinel)
    await expect(read).rejects.toBe(failure)
    expect(finalTransport(records).abortedAt).toEqual(expect.any(Number))
    expect(finalTransport(records).readErrorAt).toEqual(expect.any(Number))
    expect(finalTransport(records).eofAt).toBeUndefined()
    expect(JSON.stringify(records)).not.toContain(sentinel)
  })

  it('contains oversized and malformed frames without truncating the SDK stream', async () => {
    const bytes = enc.encode(`data: {"choices":[{"delta":{"content":"${sentinel.repeat(100)}"}}]}\n\ndata: bad-json\n\ndata: []\n\ndata: {"choices":[]}\n\ndata: {"choices":[{"finish_reason":"${sentinel}"}]}\n\ndata: [DONE]`)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)))
    const records: TransportObservationRecord[] = []
    const actual = await observation(record => records.push(record), 100).sdk.fetch!('http://fixture.test')
    expect(new Uint8Array(await actual.arrayBuffer())).toEqual(bytes)
    expect(finalTransport(records)).toMatchObject({ oversizedFrames: 1, invalidFrames: 2, finishReason: 'unknown', incompleteFrame: true })
    expect(finalTransport(records).doneAt).toBeUndefined()
    expect(JSON.stringify(records)).not.toContain(sentinel)
  })

  it('preserves empty chunks and unrecognized SSE fields without inventing completion metadata', async () => {
    const bytes = enc.encode('event: message\n\ndata\n\ndata: {"id":"chatcmpl-metadata"}\n\ndata: {"choices":[null,{"finish_reason":7}]}\n\n')
    const empty = new Uint8Array(0)
    const stream = source([empty, bytes])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream.body)))
    const records: TransportObservationRecord[] = []
    const observer = observation(record => records.push(record))
    const response = await observer.sdk.fetch!('http://fixture.test')
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toBe(empty)
    expect((await reader.read()).value).toBe(bytes)
    expect((await reader.read()).done).toBe(true)
    expect(finalTransport(records)).toMatchObject({ bytes: bytes.length, frames: 4, dataFrames: 3,
      invalidFrames: 1, responseId: 'chatcmpl-metadata', finishReason: 'unknown' })
    expect(finalTransport(records).doneAt).toBeUndefined()
    observer.end('exhausted')
    expect(records.find(record => record.event === 'adapter-end')).not.toHaveProperty('semanticFinish')
  })

  it('retains an already-aborted signal when a transport still returns a response', async () => {
    const abort = new AbortController()
    abort.abort(sentinel)
    const fetch = vi.fn(async () => new Response('data: [DONE]\n\n'))
    vi.stubGlobal('fetch', fetch)
    const records: TransportObservationRecord[] = []
    const init = { signal: abort.signal }
    const response = await observation(record => records.push(record)).sdk.fetch!('http://fixture.test', init)
    await response.text()
    expect(fetch).toHaveBeenCalledExactlyOnceWith('http://fixture.test', init)
    expect(finalTransport(records).abortedAt).toBeTypeOf('number')
    expect(finalTransport(records).eofAt).toBeTypeOf('number')
    expect(JSON.stringify(records)).not.toContain(sentinel)
  })

  it('filters response headers and records SDK response ordering without payloads', async () => {
    const headers = { 'X-Request-Id': 'req-123', 'x-openai-request-id': 'openai-456', 'request-id': 'bad value\tignored', authorization: sentinel, 'set-cookie': sentinel }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204, headers })))
    const records: TransportObservationRecord[] = []
    const observer = observation(record => records.push(record))
    await observer.sdk.fetch!('http://fixture.test')
    await observer.sdk.onResponse!({ status: 204, headers }, {} as never)
    expect(records.find(record => record.event === 'sdk-response')).toMatchObject({ httpRequest: 1, status: 204,
      requestIds: { 'x-request-id': 'req-123', 'x-openai-request-id': 'openai-456' } })
    expect(JSON.stringify(records)).not.toContain(sentinel)
  })

  it('retains HTTP failure identity and lets fetch failures propagate unchanged', async () => {
    const failure = new Error(sentinel)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(new Response('', { status: 429, headers: { 'x-request-id': 'req-rate' } })))
    const records: TransportObservationRecord[] = []
    const observer = observation(record => records.push(record))
    await expect(observer.sdk.fetch!('http://fixture.test')).rejects.toBe(failure)
    expect(finalTransport(records).fetchErrorAt).toEqual(expect.any(Number))
    const response = await observer.sdk.fetch!('http://fixture.test')
    await response.text()
    expect(records.filter(record => record.event === 'http-start').map(record => record.httpRequest)).toEqual([1, 2])
    expect(records.find(record => record.event === 'http-response')).toMatchObject({ status: 429, requestIds: { 'x-request-id': 'req-rate' } })
    expect(JSON.stringify(records)).not.toContain(sentinel)
  })

  it('keeps concurrent calls separate and contains metadata sink exceptions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: [DONE]\n\n')))
    const records: TransportObservationRecord[] = []
    let calls = 0
    const first = observation((record) => { if (calls++ === 0) throw new Error(sentinel); records.push(record) })
    const second = observation(record => records.push(record))
    await Promise.all([first, second].map(async (observer) => {
      const response = await observer.sdk.fetch!('http://fixture.test')
      await response.text()
      observer.chunk({ type: 'text-delta', index: 0, text: sentinel })
      observer.chunk({ type: 'finish', reason: { kind: 'stop' } })
      observer.end('exhausted')
    }))
    expect(new Set(records.map(record => record.callId)).size).toBe(2)
    expect(records.filter(record => record.event === 'adapter-end')).toEqual(expect.arrayContaining([
      expect.objectContaining({ semanticChunks: 2, semanticFinish: 'stop', outcome: 'exhausted', droppedRecords: 1 }),
      expect.objectContaining({ semanticChunks: 2, semanticFinish: 'stop', outcome: 'exhausted', droppedRecords: 0 }),
    ]))
    expect(JSON.stringify(records)).not.toContain(sentinel)
  })

  it('stops bounded observation when the adapter closes without claiming EOF', async () => {
    const late = enc.encode(sentinel)
    const stream = source([enc.encode('data: [DONE]\n\n'), late])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream.body)))
    const records: TransportObservationRecord[] = []
    const observer = observation(record => records.push(record))
    const response = await observer.sdk.fetch!(new Request('http://fixture.test'))
    const reader = response.body!.getReader()
    await reader.read()
    observer.chunk({ type: 'finish', reason: { kind: 'custom' } } as unknown as StreamChunk)
    observer.end('consumer-closed')
    expect(finalTransport(records).observationStoppedAt).toEqual(expect.any(Number))
    expect(finalTransport(records).eofAt).toBeUndefined()
    const stoppedRecords = JSON.stringify(records)
    expect((await reader.read()).value).toBe(late)
    expect((await reader.read()).done).toBe(true)
    expect(JSON.stringify(records)).toBe(stoppedRecords)
  })
})
