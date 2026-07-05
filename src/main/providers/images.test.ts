import { describe, expect, it } from 'vitest';
import { buildAnthropicParams } from './anthropic';
import { buildOpenAIParams } from './openai';
import type { CompletionRequest } from './types';

/** M14-1: 画像ブロックのプロバイダ写像を固定する */

const PNG = { mediaType: 'image/png', data: 'aGVsbG8=' };

function req(messages: CompletionRequest['messages']): CompletionRequest {
  return { system: 'sys', messages, tools: [], maxTokens: 100, signal: new AbortController().signal };
}

describe('Anthropic 画像写像(ネイティブ)', () => {
  it('ユーザー添付画像は image ブロック(base64 source)になる', () => {
    const params = buildAnthropicParams(
      req([{ role: 'user', content: [{ type: 'text', text: 'これ見て' }, { type: 'image', ...PNG }] }]),
      'claude-fable-5',
    );
    const content = params.messages[0]!.content as { type: string; source?: { type: string; media_type: string; data: string } }[];
    expect(content[0]).toMatchObject({ type: 'text' });
    // 末尾ブロックには prompt caching の cache_control が付くため部分一致で見る
    expect(content[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    });
  });

  it('tool_result 内の画像は text+image の配列 content になる', () => {
    const params = buildAnthropicParams(
      req([
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'screenshot', input: {} }] },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 't1', content: '撮影した', images: [PNG] }],
        },
      ]),
      'claude-fable-5',
    );
    const tr = (params.messages[1]!.content as { type: string; content?: unknown }[])[0]!;
    expect(tr.type).toBe('tool_result');
    const inner = tr.content as { type: string }[];
    expect(inner.map((b) => b.type)).toEqual(['text', 'image']);
  });

  it('画像なしの tool_result は従来どおり文字列 content(後方互換)', () => {
    const params = buildAnthropicParams(
      req([
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'grep', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }] },
      ]),
      'claude-fable-5',
    );
    const tr = (params.messages[1]!.content as { content?: unknown }[])[0]!;
    expect(tr.content).toBe('ok');
  });
});

describe('OpenAI 画像写像(互換レイヤ)', () => {
  it('ユーザー添付画像は image_url(data URL)になる', () => {
    const params = buildOpenAIParams(
      req([{ role: 'user', content: [{ type: 'image', ...PNG }] }]),
      'gpt-5.1',
    );
    const userMsg = params.messages.find((m) => m.role === 'user')!;
    expect(userMsg.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ]);
  });

  it('tool_result の画像は直後の user メッセージへ注入される(role:tool はテキストのみ)', () => {
    const params = buildOpenAIParams(
      req([
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'screenshot', input: {} }] },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 't1', content: '撮影した', images: [PNG] }],
        },
      ]),
      'gpt-5.1',
    );
    const roles = params.messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'assistant', 'tool', 'user']);
    const toolMsg = params.messages[2]!;
    expect(toolMsg.content).toBe('撮影した'); // tool はテキストのみ
    const injected = params.messages[3]!.content as { type: string }[];
    expect(injected.map((b) => b.type)).toEqual(['text', 'image_url']);
  });

  it('画像なしの履歴は従来と同一構造(後方互換)', () => {
    const params = buildOpenAIParams(
      req([
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'grep', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }] },
      ]),
      'gpt-5.1',
    );
    expect(params.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  });
});
