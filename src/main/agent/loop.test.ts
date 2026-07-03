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

/** 履歴の整合性検査: すべての tool_use ブロックに対応する tool_result が存在する(API 400 防止の不変条件) */
function assertToolPairing(history: { role: string; content: unknown[] }[]): void {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const msg of history) {
    for (const b of msg.content as { type?: string; id?: string; toolUseId?: string }[]) {
      if (b.type === 'tool_use' && typeof b.id === 'string') toolUseIds.add(b.id);
      if (b.type === 'tool_result' && typeof b.toolUseId === 'string') toolResultIds.add(b.toolUseId);
    }
  }
  for (const id of toolUseIds) {
    expect(toolResultIds.has(id), `tool_use ${id} に対応する tool_result が無い`).toBe(true);
  }
}

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

  // --- 回帰: キャンセル/max_tokens で tool_use が tool_result 無しで残ると次リクエストが恒久的に 400 になる ---

  it('ツール実行ループ中のキャンセルでも全 tool_use に tool_result が対応する(履歴整合)', async () => {
    const ac = new AbortController();
    // 1メッセージに2つの tool_use。1つ目実行時に abort する。
    const provider = mockProvider([
      [
        { type: 'tool_use_start', id: 'tu1', name: 'grep' },
        { type: 'tool_use_start', id: 'tu2', name: 'grep' },
        {
          type: 'message_done',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu1', name: 'grep', input: {} },
              { type: 'tool_use', id: 'tu2', name: 'grep', input: {} },
            ],
          },
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
        },
      ],
    ]);
    const h = harness(provider, { content: 'x' }, {
      executeTool: async () => {
        ac.abort(); // 1つ目のツール実行中にキャンセルされる状況を再現
        return { content: 'x' };
      },
    });
    const history = [userMsg('go')];
    const status = await runAgentLoop(h.deps, 's1', history, ac.signal);

    expect(status).toBe('cancelled');
    // 末尾は tool_result をまとめた user メッセージで、tool_use と同数(2件)対応する
    const lastMsg = history[history.length - 1]!;
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content.filter((b) => (b as { type: string }).type === 'tool_result')).toHaveLength(2);
    assertToolPairing(history);
  });

  it('max_tokens で tool_use を含む応答が来ても合成 tool_result で履歴が閉じる', async () => {
    const provider = mockProvider([
      [
        {
          type: 'message_done',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'cut1', name: 'write_file', input: { path: 'a' } }],
          },
          stopReason: 'max_tokens',
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
        },
      ],
    ]);
    const h = harness(provider);
    const history = [userMsg('go')];
    const status = await runAgentLoop(h.deps, 's1', history, new AbortController().signal);

    expect(status).toBe('done');
    // 途中終了なのでツールは実行されない
    expect(h.toolCalls).toHaveLength(0);
    assertToolPairing(history);
    expect(h.events.some((e) => e.kind === 'error' && e.message.includes('トークン上限'))).toBe(true);
  });

  it('キャンセル後の履歴で follow-up リクエストが tool_result 欠落にならない', async () => {
    // 1ターン目: tool_use → 実行中に abort。2ターン目(別 runAgentLoop 呼び出し)が
    // 壊れた履歴を送っても provider へ渡る messages が整合していることを確認する。
    const ac = new AbortController();
    const provider = mockProvider([
      toolUseResponse('tu1', 'read_file', { path: 'a.txt' }),
      textResponse('ok'),
    ]);
    const h = harness(provider, { content: 'x' }, {
      executeTool: async () => {
        ac.abort();
        return { content: 'x' };
      },
    });
    const history = [userMsg('go')];
    await runAgentLoop(h.deps, 's1', history, ac.signal);
    assertToolPairing(history);

    // 履歴を引き継いで2回目を実行(キャンセルしない新しい signal)
    history.push(userMsg('続けて'));
    const status2 = await runAgentLoop(h.deps, 's2', history, new AbortController().signal);
    expect(status2).toBe('done');
    // 2回目のリクエストに渡った messages 内で tool_use/tool_result が対応している
    const sent = provider.requests[provider.requests.length - 1]!.messages as {
      role: string;
      content: unknown[];
    }[];
    assertToolPairing(sent);
  });

  it('引数JSON解析失敗(inputError付きtool_use)は実行せずエラーtool_resultを返す(指摘#7)', async () => {
    const provider = mockProvider([
      [
        {
          type: 'message_done',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'bad1', name: 'write_file', input: {}, inputError: '引数のJSON解析に失敗した(途中切れ)' },
            ],
          },
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
        },
      ],
      textResponse('やり直す'),
    ]);
    const h = harness(provider, { content: 'should-not-run' });
    const history = [userMsg('go')];
    const status = await runAgentLoop(h.deps, 's1', history, new AbortController().signal);

    expect(status).toBe('done');
    expect(h.toolCalls).toHaveLength(0); // 実行されない
    expect(h.events.some((e) => e.kind === 'error' && e.message.includes('解析に失敗'))).toBe(true);
    assertToolPairing(history);
    // tool_result はエラーとして積まれ、次ターンへ整合した履歴が渡る
    expect(history[2]!.content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'bad1', isError: true });
  });

  it('プランモードではツールを実行しない(承認前実行の防止・M8-3)', async () => {
    const provider = mockProvider([
      // モデルが(誤って)tool_use を出しても実行されないこと
      toolUseResponse('p1', 'write_file', { path: 'a', content: 'x' }),
      textResponse('これは計画です'),
    ]);
    const h = harness(provider, { content: 'MUST-NOT-RUN' }, { planMode: true });
    const history = [userMsg('実装して')];
    const status = await runAgentLoop(h.deps, 's1', history, new AbortController().signal);

    expect(status).toBe('done');
    expect(h.toolCalls).toHaveLength(0); // 一切実行されない
    assertToolPairing(history); // 履歴整合(合成tool_resultで閉じる)
    expect(history[2]!.content[0]).toMatchObject({ type: 'tool_result', isError: true });
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
