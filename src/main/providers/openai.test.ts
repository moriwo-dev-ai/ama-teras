import { describe, expect, it } from 'vitest';
import { buildOpenAIParams, normalizeOpenAIStream } from './openai';
import type { CompletionRequest, ProviderEvent } from './types';

function req(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'こんにちは' }] }],
    tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} } }],
    maxTokens: 1000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function* fromArray(events: unknown[]): AsyncIterable<unknown> {
  for (const e of events) yield e;
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('buildOpenAIParams(形式変換)', () => {
  it('systemが先頭メッセージになりtoolsがfunction形式になる', () => {
    const params = buildOpenAIParams(req(), 'gpt-5.1');
    expect(params.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(params.tools).toEqual([
      {
        type: 'function',
        function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
      },
    ]);
    expect(params.stream).toBe(true);
    expect(params.max_completion_tokens).toBe(1000);
  });

  it('tool_use → tool_calls、tool_result → role:tool に変換される', () => {
    const params = buildOpenAIParams(
      req({
        messages: [
          { role: 'user', content: [{ type: 'text', text: '読んで' }] },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: '読みます' },
              { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 'call_1', content: '中身', isError: false }],
          },
        ],
      }),
      'gpt-5.1',
    );

    expect(params.messages[2]).toEqual({
      role: 'assistant',
      content: '読みます',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
      ],
    });
    expect(params.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '中身' });
  });

  it('テキストなしのtool_useのみのassistantは content:null', () => {
    const params = buildOpenAIParams(
      req({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'x' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'grep', input: {} }] },
        ],
      }),
      'gpt-5.1',
    );
    expect(params.messages[2]).toMatchObject({ role: 'assistant', content: null });
  });
});

describe('normalizeOpenAIStream', () => {
  it('テキストストリームを正規化する', async () => {
    const events = await collect(
      normalizeOpenAIStream(
        fromArray([
          { choices: [{ delta: { content: 'こん' } }] },
          { choices: [{ delta: { content: 'にちは' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } } },
        ]),
      ),
    );
    const done = events.at(-1) as Extract<ProviderEvent, { type: 'message_done' }>;
    expect(done.stopReason).toBe('end_turn');
    expect(done.message.content).toEqual([{ type: 'text', text: 'こんにちは' }]);
    expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 });
  });

  it('tool_callsの分割argumentsを組み立てる', async () => {
    const events = await collect(
      normalizeOpenAIStream(
        fromArray([
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'read_file', arguments: '' } }] } },
            ],
          },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    expect(events.some((e) => e.type === 'tool_use_start' && e.id === 'call_9')).toBe(true);
    const done = events.at(-1) as Extract<ProviderEvent, { type: 'message_done' }>;
    expect(done.stopReason).toBe('tool_use');
    expect(done.message.content).toEqual([
      { type: 'tool_use', id: 'call_9', name: 'read_file', input: { path: 'a.txt' } },
    ]);
  });

  it('lengthはmax_tokens、content_filterはrefusalに写像', async () => {
    const mk = (reason: string) =>
      collect(
        normalizeOpenAIStream(
          fromArray([
            { choices: [{ delta: { content: 'x' } }] },
            { choices: [{ delta: {}, finish_reason: reason }] },
          ]),
        ),
      );
    expect(((await mk('length')).at(-1) as { stopReason: string }).stopReason).toBe('max_tokens');
    expect(((await mk('content_filter')).at(-1) as { stopReason: string }).stopReason).toBe('refusal');
  });
});
