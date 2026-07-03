import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../shared/types';
import type { CompletionRequest, LLMProvider, ProviderEvent } from '../providers/types';
import type { ToolContext, ToolResult } from '../tools/types';
import { runAgentLoop, type AgentLoopDeps } from './loop';

function textResponse(text: string): ProviderEvent[] {
  return [
    { type: 'text_delta', text },
    {
      type: 'message_done',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    },
  ];
}

function toolUseResponse(id: string, name: string, input: unknown): ProviderEvent[] {
  return [
    { type: 'tool_use_start', id, name },
    {
      type: 'message_done',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    },
  ];
}

function mockProvider(responses: ProviderEvent[][]): LLMProvider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    id: 'anthropic',
    requests,
    async *complete(req: CompletionRequest) {
      // history は参照で渡ってくるため、呼び出し時点のスナップショットを保存する
      requests.push({ ...req, messages: [...req.messages] });
      const next = responses.shift();
      if (!next) throw new Error('モック応答が尽きた');
      yield* next;
    },
  };
}

interface Harness {
  deps: AgentLoopDeps;
  events: AgentEvent[];
  toolCalls: { name: string; input: unknown }[];
}

function harness(
  provider: LLMProvider,
  toolResult: ToolResult = { content: 'ok' },
  overrides: Partial<AgentLoopDeps> = {},
): Harness {
  const events: AgentEvent[] = [];
  const toolCalls: { name: string; input: unknown }[] = [];
  const deps: AgentLoopDeps = {
    provider,
    tools: { list: () => [] },
    executeTool: async (name: string, input: unknown, _ctx: ToolContext) => {
      toolCalls.push({ name, input });
      return toolResult;
    },
    emit: (e) => events.push(e),
    systemPrompt: 'test',
    cwd: process.cwd(),
    ...overrides,
  };
  return { deps, events, toolCalls };
}

const userMsg = (text: string): { role: 'user'; content: [{ type: 'text'; text: string }] } => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

describe('runAgentLoop', () => {
  it('テキスト応答のみで done、履歴にassistantが積まれる', async () => {
    const provider = mockProvider([textResponse('こんにちは')]);
    const h = harness(provider);
    const history = [userMsg('hi')];
    const status = await runAgentLoop(h.deps, 's1', history, new AbortController().signal);

    expect(status).toBe('done');
    expect(history).toHaveLength(2);
    expect(history[1]!.role).toBe('assistant');
    expect(h.events.some((e) => e.kind === 'text_delta' && e.text === 'こんにちは')).toBe(true);
    expect(h.events.at(-1)).toEqual({ kind: 'status', sessionId: 's1', status: 'done' });
  });

  it('tool_use連鎖: 実行結果がtool_resultとして履歴に入り、次ターンへ続く', async () => {
    const provider = mockProvider([
      toolUseResponse('tu1', 'read_file', { path: 'a.txt' }),
      textResponse('読めた'),
    ]);
    const h = harness(provider, { content: 'ファイル内容' });
    const history = [userMsg('a.txtを読んで')];
    const status = await runAgentLoop(h.deps, 's1', history, new AbortController().signal);

    expect(status).toBe('done');
    expect(h.toolCalls).toEqual([{ name: 'read_file', input: { path: 'a.txt' } }]);
    // user → assistant(tool_use) → user(tool_result) → assistant(text)
    expect(history).toHaveLength(4);
    expect(history[2]!.content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'tu1', content: 'ファイル内容' });
    // 2回目のリクエストにはtool_resultまで含まれる
    expect(provider.requests[1]!.messages).toHaveLength(3);
    expect(h.events.some((e) => e.kind === 'tool_start' && e.name === 'read_file')).toBe(true);
    expect(h.events.some((e) => e.kind === 'tool_result' && e.content === 'ファイル内容')).toBe(true);
  });

  it('maxTurns超過で max_turns_reached', async () => {
    const provider = mockProvider([
      toolUseResponse('t1', 'grep', {}),
      toolUseResponse('t2', 'grep', {}),
      toolUseResponse('t3', 'grep', {}),
    ]);
    const h = harness(provider, { content: 'x' }, { maxTurns: 2 });
    const status = await runAgentLoop(h.deps, 's1', [userMsg('go')], new AbortController().signal);
    expect(status).toBe('max_turns_reached');
    expect(provider.requests).toHaveLength(2);
  });

  it('開始前にabort済みなら cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    const provider = mockProvider([textResponse('unused')]);
    const h = harness(provider);
    const status = await runAgentLoop(h.deps, 's1', [userMsg('go')], ac.signal);
    expect(status).toBe('cancelled');
    expect(provider.requests).toHaveLength(0);
  });

  it('ストリーム途中のabortは cancelled(例外を握りつぶさずステータス化)', async () => {
    const ac = new AbortController();
    const provider: LLMProvider = {
      id: 'anthropic',
      // eslint-disable-next-line require-yield
      async *complete() {
        ac.abort();
        throw new Error('aborted');
      },
    };
    const h = harness(provider);
    const status = await runAgentLoop(h.deps, 's1', [userMsg('go')], ac.signal);
    expect(status).toBe('cancelled');
  });

  it('プロバイダ例外は error ステータスとエラーイベント', async () => {
    const provider: LLMProvider = {
      id: 'anthropic',
      // eslint-disable-next-line require-yield
      async *complete() {
        throw new Error('API死んだ');
      },
    };
    const h = harness(provider);
    const status = await runAgentLoop(h.deps, 's1', [userMsg('go')], new AbortController().signal);
    expect(status).toBe('error');
    expect(h.events.some((e) => e.kind === 'error' && e.message.includes('API死んだ'))).toBe(true);
  });

  it('空コンテンツ応答(refusal等)は error', async () => {
    const provider = mockProvider([
      [
        {
          type: 'message_done',
          message: { role: 'assistant', content: [] },
          stopReason: 'refusal',
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
        },
      ],
    ]);
    const h = harness(provider);
    const status = await runAgentLoop(h.deps, 's1', [userMsg('go')], new AbortController().signal);
    expect(status).toBe('error');
  });
});
