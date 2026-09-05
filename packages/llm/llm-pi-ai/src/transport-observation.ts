/**
 * Session-scoped HTTP/SSE metadata observation; payload bytes never reach the sink.
 * @module dsh-llm-pi-ai/transport-observation
 */
import { randomUUID } from 'node:crypto'
import type { SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Explicit deployment bounds; absence of this configuration disables observation. */
export interface TransportObservationConfig {
  /** Exact Session IDs; wildcards and empty lists are refused by configuration validation. */
  sessionIds: string[]
  /** Maximum retained bytes for one SSE frame; larger frames are counted but not parsed. */
  maxFrameBytes: number
}

/** Metadata-only record sent to the existing plugin logger, never the model or Session log. */
export interface TransportObservationRecord {
  event: 'adapter-start' | 'http-start' | 'http-response' | 'sdk-response' | 'http-abort' | 'http-end' | 'adapter-end' | 'unsupported-api'
  callId: string
  sessionId: NonNullable<GenerateOptions['sessionId']>
  provider: string
  model: string
  time: number
  /** Ordinal within this adapter call, not an official Agent attempt number. */
  httpRequest?: number
  status?: number
  requestIds?: Record<string, string>
  transport?: TransportSummary
  semanticChunks?: number
  semanticFinish?: 'stop' | 'tool-calls' | 'max-tokens' | 'error' | 'aborted' | 'unknown'
  outcome?: 'exhausted' | 'error' | 'aborted' | 'consumer-closed'
  droppedRecords: number
}

/** Bounded counts and terminal observations for one HTTP body. */
interface TransportSummary {
  bytes: number
  frames: number
  dataFrames: number
  commentFrames: number
  invalidFrames: number
  oversizedFrames: number
  responseId?: string
  firstByteAt?: number
  lastByteAt?: number
  finishAt?: number
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'function_call' | 'content_filter' | 'network_error' | 'unknown'
  doneAt?: number
  eofAt?: number
  abortedAt?: number
  cancelledAt?: number
  readErrorAt?: number
  fetchErrorAt?: number
  observationStoppedAt?: number
  incompleteFrame: boolean
}

/** Per-call observer injection; callbacks receive no request body or raw response. */
export interface TransportObservationOptions {
  /** Current validated deployment settings, captured once when the adapter call starts. */
  config: () => TransportObservationConfig | null | undefined
  /** Synchronous metadata sink; failures are counted without changing provider behavior. */
  emit: (record: TransportObservationRecord) => void
}

/** SDK hooks plus observations at the existing adapter iterator. */
export interface StreamObservation {
  sdk: Pick<SimpleStreamOptions, 'fetch' | 'onResponse'>
  chunk: (chunk: StreamChunk) => void
  end: (outcome: NonNullable<TransportObservationRecord['outcome']>) => void
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/
const REQUEST_HEADERS = ['x-request-id', 'x-openai-request-id', 'request-id'] as const

function requestIds(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of REQUEST_HEADERS) {
    const value = headers.get(name)
    if (value !== null && ID.test(value)) result[name] = value
  }
  return result
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** One bounded frame buffer; no message text survives frame classification. */
class SseMetadata {
  readonly summary: TransportSummary = {
    bytes: 0, frames: 0, dataFrames: 0, commentFrames: 0, invalidFrames: 0,
    oversizedFrames: 0, incompleteFrame: false,
  }

  private readonly buffer: Uint8Array
  private size = 0
  private lineBytes = 0
  private skipLf = false
  private oversized = false

  constructor(maxFrameBytes: number) {
    this.buffer = new Uint8Array(maxFrameBytes)
  }

  add(bytes: Uint8Array): void {
    const now = Date.now()
    this.summary.bytes += bytes.byteLength
    if (bytes.byteLength > 0) {
      this.summary.firstByteAt ??= now
      this.summary.lastByteAt = now
    }
    for (const byte of bytes) {
      if (this.skipLf && byte === 10) { this.skipLf = false; continue }
      this.skipLf = byte === 13
      if (this.size < this.buffer.byteLength) this.buffer[this.size++] = byte
      else this.oversized = true
      if (byte === 10 || byte === 13) {
        if (this.lineBytes === 0) this.frame(now)
        this.lineBytes = 0
      } else this.lineBytes++
      this.summary.incompleteFrame = this.size > 0 || this.oversized
    }
  }

  private frame(now: number): void {
    this.summary.frames++
    if (this.oversized) this.summary.oversizedFrames++
    else {
      const lines = new TextDecoder().decode(this.buffer.subarray(0, this.size)).split(/\r\n|\r|\n/)
      const data: string[] = []
      let comment = false
      for (const line of lines) {
        if (line.startsWith(':')) comment = true
        if (line === 'data') data.push('')
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (comment) this.summary.commentFrames++
      if (data.length > 0) {
        this.summary.dataFrames++
        const value = data.join('\n')
        if (value === '[DONE]') this.summary.doneAt ??= now
        else this.json(value, now)
      }
    }
    this.buffer.fill(0, 0, this.size)
    this.size = 0
    this.oversized = false
  }

  private json(data: string, now: number): void {
    let parsed: unknown
    try { parsed = JSON.parse(data) }
    catch (_invalidSseJson) { this.summary.invalidFrames++; return }
    const value = object(parsed)
    if (value === undefined) { this.summary.invalidFrames++; return }
    if (typeof value.id === 'string' && ID.test(value.id)) this.summary.responseId ??= value.id
    if (!Array.isArray(value.choices)) return
    for (const choice of value.choices) {
      const reason = object(choice)?.finish_reason
      if (reason === null || reason === undefined) continue
      this.summary.finishAt ??= now
      if (typeof reason !== 'string') { this.summary.finishReason ??= 'unknown'; continue }
      switch (reason) {
        case 'stop': case 'length': case 'tool_calls': case 'function_call': case 'content_filter': case 'network_error':
          this.summary.finishReason ??= reason
          break
        default: this.summary.finishReason ??= 'unknown'
      }
    }
  }

  clear(): void { this.buffer.fill(0) }
}

function observedResponse(response: Response, body: ReadableStream<Uint8Array>): Response {
  const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  // Response's URL metadata is not accepted by its constructor; preserve it on the SDK-facing response.
  return new Proxy(observed, {
    get(target, property) {
      if (property === 'url' || property === 'redirected' || property === 'type') return response[property]
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) as unknown : value
    },
  })
}

/**
 * Observe only an explicitly selected Session using the OpenAI-completions HTTP API.
 * @param request - Model routing and Session identity, without model-visible inputs.
 * @param api - The model's actual pi-ai protocol; unsupported APIs keep their original transport.
 * @param options - Optional validated settings and metadata sink.
 * @returns Per-call hooks, or undefined when observation is disabled or the Session is not selected.
 */
export function observeTransport(
  request: Pick<GenerateOptions, 'sessionId' | 'provider' | 'model'>,
  api: string,
  options: TransportObservationOptions | undefined,
): StreamObservation | undefined {
  if (options === undefined) return undefined
  const config = options.config()
  if (config === undefined || config === null || request.sessionId === undefined
    || !config.sessionIds.includes(request.sessionId)) return undefined
  const sink = options.emit
  const sessionId = request.sessionId
  const callId = randomUUID()
  let droppedRecords = 0
  function emit(record: Omit<TransportObservationRecord, 'callId' | 'sessionId' | 'provider' | 'model' | 'time' | 'droppedRecords'>): void {
    try {
      sink({ ...record, callId, sessionId, provider: request.provider, model: request.model, time: Date.now(), droppedRecords })
    } catch (_metadataSinkFailure) { droppedRecords++ }
  }
  if (api !== 'openai-completions') { emit({ event: 'unsupported-api' }); return undefined }
  emit({ event: 'adapter-start' })
  let httpRequest = 0
  let semanticChunks = 0
  let semanticFinish: TransportObservationRecord['semanticFinish']
  const baseFetch = globalThis.fetch
  const pending = new Set<() => void>()
  return {
    sdk: {
      async fetch(input, init) {
        const ordinal = ++httpRequest
        const parser = new SseMetadata(config.maxFrameBytes)
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        let ended = false
        function end(): void {
          if (ended) return
          ended = true
          signal?.removeEventListener('abort', abort)
          pending.delete(stop)
          emit({ event: 'http-end', httpRequest: ordinal, transport: { ...parser.summary } })
          parser.clear()
        }
        function abort(): void {
          parser.summary.abortedAt ??= Date.now()
          emit({ event: 'http-abort', httpRequest: ordinal, transport: { ...parser.summary } })
        }
        function stop(): void { parser.summary.observationStoppedAt = Date.now(); end() }
        pending.add(stop)
        signal?.addEventListener('abort', abort, { once: true })
        emit({ event: 'http-start', httpRequest: ordinal })
        let response: Response
        try { response = await baseFetch(input, init) }
        catch (error) {
          parser.summary.fetchErrorAt = Date.now()
          end()
          throw error
        }
        if (signal?.aborted) abort()
        emit({ event: 'http-response', httpRequest: ordinal, status: response.status, requestIds: requestIds(response.headers) })
        if (response.body === null) { end(); return response }
        const reader = response.body.getReader()
        return observedResponse(response, new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const result = await reader.read()
              if (result.done) {
                parser.summary.eofAt = Date.now()
                end()
                reader.releaseLock()
                controller.close()
              } else {
                if (!ended) parser.add(result.value)
                controller.enqueue(result.value)
              }
            } catch (error) {
              parser.summary.readErrorAt = Date.now()
              end()
              reader.releaseLock()
              controller.error(error)
            }
          },
          async cancel(reason) {
            parser.summary.cancelledAt = Date.now()
            end()
            try { await reader.cancel(reason) }
            finally { reader.releaseLock() }
          },
        }, { highWaterMark: 0 }))
      },
      onResponse(response) {
        emit({ event: 'sdk-response', httpRequest, status: response.status, requestIds: requestIds(new Headers(response.headers)) })
      },
    },
    chunk(chunk) {
      semanticChunks++
      if (chunk.type !== 'finish') return
      switch (chunk.reason.kind) {
        case 'stop': case 'tool-calls': case 'max-tokens': case 'error': case 'aborted': semanticFinish = chunk.reason.kind; break
        default: semanticFinish = 'unknown'
      }
    },
    end(outcome) {
      for (const stop of pending) stop()
      emit({ event: 'adapter-end', outcome, semanticChunks, ...(semanticFinish === undefined ? {} : { semanticFinish }) })
    },
  }
}
