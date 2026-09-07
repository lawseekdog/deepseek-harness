import { describe, expect, it } from 'vitest'
import { BlockAssembler, createMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Model, ToolCall } from '@earendil-works/pi-ai'
import { stream } from '@earendil-works/pi-ai/api/openai-responses'
import { toPiAssistant } from '../src/replay.ts'
import { toStreamChunks } from '../src/stream.ts'
import { rawArgumentResponse } from './raw-arguments-fixture.ts'

const model: Model<'openai-responses'> = {
  id: 'raw-test', name: 'raw-test', provider: 'test', api: 'openai-responses',
  baseUrl: 'https://provider.invalid/v1', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
}

const cases = [
  '{"item":{"count":1}', '{"text":"line\nbreak"}', '{"path":"C:\\q"}',
  '{"item":{"count":1} "other":2}', '', 'null', '[1,2]', '42',
  ' { "材料": "中文😀", "count": 1 }\n',
]

describe('raw Tool arguments across the SDK and Harness', () => {
  it.each(cases)('records and replays final provider text %j', async (raw) => {
    const native = stream(model, { messages: [{ role: 'user', content: 'inspect', timestamp: 0 }] }, {
      apiKey: 'test-key', fetch: async () => rawArgumentResponse(raw), maxRetries: 0,
    })
    const assembler = new BlockAssembler()
    for await (const chunk of toStreamChunks(native)) assembler.push(chunk)
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
    const recorded = assembler.message({ kind: 'model', provider: model.provider, model: model.id, replayState: assembler.replayState })
    expect(recorded.content).toEqual([{ type: 'tool-call', id: 'call_a|fc_a', name: 'inspect', arguments: raw }])
    const persisted = JSON.parse(JSON.stringify(recorded)) as Message
    const replayed = toPiAssistant(persisted)
    const call = replayed.content[0] as ToolCall
    expect(call.rawArguments).toBe(raw)
    expect(call.arguments).toEqual(raw.includes('材料') ? { 材料: '中文😀', count: 1 } : undefined)
    let sent: { input: Array<{ type?: string; arguments?: string }> } | undefined
    await stream(model, { messages: [replayed, {
      role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: 'INVALID_ARGS' }], isError: true, timestamp: 1,
    }] }, {
      apiKey: 'test-key', maxRetries: 0,
      fetch: async (_url, init) => {
        if (typeof init?.body !== 'string') throw new Error('Expected JSON request body')
        sent = JSON.parse(init.body) as typeof sent
        return rawArgumentResponse('{"ok":true}')
      },
    }).result()
    expect(sent?.input.find(entry => entry.type === 'function_call')?.arguments).toBe(raw)
  })

  it.each(cases)('keeps foreign history raw arguments %j', (raw) => {
    const replayed = toPiAssistant(createMessage({
      role: 'assistant', source: { kind: 'plugin', plugin: 'test' },
      content: [{ type: 'tool-call', id: ToolCallId('c'), name: 'inspect', arguments: raw }],
    }))
    expect(replayed.content[0]).toMatchObject({ rawArguments: raw })
  })

  it('retains the provider max-token finish for incomplete arguments', async () => {
    const assembler = new BlockAssembler()
    const native = stream(model, { messages: [] }, { apiKey: 'test-key', fetch: async () => rawArgumentResponse('{', 'incomplete') })
    for await (const chunk of toStreamChunks(native)) assembler.push(chunk)
    expect(assembler.finish).toEqual({ kind: 'max-tokens' })
    expect(assembler.blocks()).toEqual([])
    expect(assembler.replayState?.blocks).toEqual([])
  })
})
