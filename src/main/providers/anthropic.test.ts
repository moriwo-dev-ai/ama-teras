import { describe, expect, it } from 'vitest';
import { buildAnthropicParams, normalizeAnthropicStream } from './anthropic';
import type { CompletionRequest, ProviderEvent } from './types';

function req(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    system: 'システムプロンプト',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'こんにちは' }] }],
    tools: [
      { name: 'a', description: 'tool a', inputSchema: { type: 'object', properties: {} } },
      { name: 'b', description: 'tool b', inputSchema: { type: 'object', properties: {} } },
    ],
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

describe('buildAnthropicParams(prompt caching)', () => {
  it('systemブロックに cache_control が付く', () => {
    const params = buildAnthropicParams(req(), 'claude-opus-4-8');
    expect(params.system).toEqual([
      { type: 'text', text: 'システムプロンプト', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('ツール定義は最終要素のみ cache_control が付く', () => {
    const params = buildAnthropicParams(req(), 'claude-opus-4-8');
    const tools = params.tools as { name: string; cache_control?: unknown }[];
    expect(tools[0]!.cache_control).toBeUndefined();
    expect(tools[1]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('会話履歴の最終ブロックに cache_control が付く', () => {
    const params = buildAnthropicParams(
      req({
        messages: [
          { role: 'user', content: [{ type: 'text', text: '1' }] },
          { role: 'assistant', content: [{ type: 'text', text: '2' }] },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 'tu1', content: 'result', isError: false }],
          },
        ],
      }),
      'claude-opus-4-8',
    );
    const last = params.messages.at(-1)!.content;
    expect(Array.isArray(last)).toBe(true);
    const block = (last as unknown as Record<string, unknown>[]).at(-1)!;
    expect(block['type']).toBe('tool_result');
    expect(block['tool_use_id']).toBe('tu1');
    expect(block['cache_control']).toEqual({ type: 'ephemeral' });
    // 先頭メッセージには付かない
    const first = (params.messages[0]!.content as unknown as Record<string, unknown>[])[0]!;
    expect(first['cache_control']).toBeUndefined();
  });

  it('streamとmodelとmax_tokensが設定される', () => {
    const params = buildAnthropicParams(req(), 'claude-opus-4-8');
    expect(params.stream).toBe(true);
    expect(params.model).toBe('claude-opus-4-8');
    expect(params.max_tokens).toBe(1000);
  });
});

describe('normalizeAnthropicStream', () => {
  it('テキスト応答: text_delta列と message_done を返す', async () => {
    const events = await collect(
      normalizeAnthropicStream(
        fromArray([
          { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 50 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'こん' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'にちは' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
          { type: 'message_stop' },
        ]),
      ),
    );

    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text)).toEqual([
      'こん',
      'にちは',
    ]);
    const done = events.at(-1)!;
    expect(done).toMatchObject({
      type: 'message_done',
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 50 },
    });
    expect((done as { message: { content: unknown[] } }).message.content).toEqual([
      { type: 'text', text: 'こんにちは' },
    ]);
  });

  it('tool_use: input_json_delta を組み立てて最終メッセージに載せる', async () => {
    const events = await collect(
      normalizeAnthropicStream(
        fromArray([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '読みます' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'read_file' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
          { type: 'message_stop' },
        ]),
      ),
    );

    expect(events.some((e) => e.type === 'tool_use_start' && e.id === 'tu1')).toBe(true);
    const done = events.at(-1) as Extract<ProviderEvent, { type: 'message_done' }>;
    expect(done.stopReason).toBe('tool_use');
    expect(done.message.content).toEqual([
      { type: 'text', text: '読みます' },
      { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a.txt' } },
    ]);
  });

  it('入力JSONが空のtool_useは input {} になる', async () => {
    const events = await collect(
      normalizeAnthropicStream(
        fromArray([
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'list_dir' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]),
      ),
    );
    const done = events.at(-1) as Extract<ProviderEvent, { type: 'message_done' }>;
    expect(done.message.content[0]).toMatchObject({ type: 'tool_use', input: {} });
  });

  it('未知のstop_reasonは other に落ちる', async () => {
    const events = await collect(
      normalizeAnthropicStream(
        fromArray([
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
          { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]),
      ),
    );
    expect((events.at(-1) as { stopReason: string }).stopReason).toBe('other');
  });
});
