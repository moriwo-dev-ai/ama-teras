import { describe, expect, it } from 'vitest';
import { buildOpenAIParams, normalizeOpenAIStream, OpenAIProvider } from './openai';
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

  /**
   * 実害(2026-07-17): GeminiのOpenAI互換APIは tool_calls に index を付けない(1チャンク完結)。
   * 以前は index 無しを黙って捨てていたため、Geminiがツールを呼ぶたびに応答が空になり
   * 「モデル応答が空だった」で実タスクが一切進まなかった(配布版の無料モードで発生)。
   */
  it('Gemini形式: index無しの1チャンク完結tool_callを取りこぼさない', async () => {
    const events = await collect(
      normalizeOpenAIStream(
        fromArray([
          {
            choices: [
              { delta: { tool_calls: [{ id: 'g_1', function: { name: 'list_dir', arguments: '{"path":"."}' } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    const done = events.at(-1) as Extract<ProviderEvent, { type: 'message_done' }>;
    expect(done.message.content).toEqual([
      { type: 'tool_use', id: 'g_1', name: 'list_dir', input: { path: '.' } },
    ]);
  });

  it('Gemini形式: index無しの複数tool_call(idで区別)を順に組み立てる', async () => {
    const events = await collect(
      normalizeOpenAIStream(
        fromArray([
          { choices: [{ delta: { tool_calls: [{ id: 'g_1', function: { name: 'read_file', arguments: '{"path":"a"}' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ id: 'g_2', function: { name: 'grep', arguments: '{"pattern":"x"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    const done = events.at(-1) as Extract<ProviderEvent, { type: 'message_done' }>;
    expect(done.message.content).toEqual([
      { type: 'tool_use', id: 'g_1', name: 'read_file', input: { path: 'a' } },
      { type: 'tool_use', id: 'g_2', name: 'grep', input: { pattern: 'x' } },
    ]);
  });

  it('index無し・id無しの継続チャンクは直前の呼び出しへ追記される', async () => {
    const events = await collect(
      normalizeOpenAIStream(
        fromArray([
          { choices: [{ delta: { tool_calls: [{ id: 'g_1', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ function: { arguments: '"a.txt"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    const done = events.at(-1) as Extract<ProviderEvent, { type: 'message_done' }>;
    expect(done.message.content).toEqual([
      { type: 'tool_use', id: 'g_1', name: 'read_file', input: { path: 'a.txt' } },
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

describe('M27-1: OpenAI互換エンドポイント(baseURL/max_tokensパラメータ)', () => {
  it('maxTokensParam=max_tokens 指定で max_completion_tokens の代わりに max_tokens を使う', () => {
    const params = buildOpenAIParams(req(), 'gemini-2.5-flash', { maxTokensParam: 'max_tokens' });
    expect(params.max_tokens).toBe(1000);
    expect(params.max_completion_tokens).toBeUndefined();
  });

  it('opts省略時は従来どおり max_completion_tokens(後方互換)', () => {
    const params = buildOpenAIParams(req(), 'gpt-5.5');
    expect(params.max_completion_tokens).toBe(1000);
    expect(params.max_tokens).toBeUndefined();
  });

  it('OpenAIProvider は baseURL を SDK クライアントへ注入する(未指定なら本家URL)', () => {
    const compat = new OpenAIProvider('key', 'gemini-2.5-flash', 'https://example.com/v1');
    const compatClient = (compat as unknown as { client: { baseURL: string } }).client;
    expect(compatClient.baseURL).toBe('https://example.com/v1');

    const vanilla = new OpenAIProvider('key', 'gpt-5.5');
    const vanillaClient = (vanilla as unknown as { client: { baseURL: string } }).client;
    expect(vanillaClient.baseURL).toContain('api.openai.com');
  });
});

describe('M29-1: baseURL の末尾スラッシュ正規化', () => {
  it('末尾スラッシュあり/なしのどちらでも同じ baseURL になる("//" 連結による404の防止)', () => {
    const withSlash = new OpenAIProvider('k', 'gemini-3.5-flash', 'https://generativelanguage.googleapis.com/v1beta/openai/');
    const withoutSlash = new OpenAIProvider('k', 'gemini-3.5-flash', 'https://generativelanguage.googleapis.com/v1beta/openai');
    const urlOf = (p: OpenAIProvider): string =>
      (p as unknown as { client: { baseURL: string } }).client.baseURL;
    expect(urlOf(withSlash)).toBe(urlOf(withoutSlash));
    expect(urlOf(withSlash).endsWith('/')).toBe(false);
  });
});
