/** Responses SSE with deliberately different delta, argument-done, and final-item text. */
export function rawArgumentResponse(raw: string, status: 'completed' | 'incomplete' = 'completed'): Response {
  const item = { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'inspect', arguments: raw }
  const events = [
    { type: 'response.created', response: { id: 'resp_a' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"delta":true}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_a', arguments: '{"argumentDone":true}' },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: status === 'completed' ? 'response.completed' : 'response.incomplete',
      response: {
        id: 'resp_a', status, output: [item],
        ...status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {},
      },
    },
  ]
  return new Response(events.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })
}
