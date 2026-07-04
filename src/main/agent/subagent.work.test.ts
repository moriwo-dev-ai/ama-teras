import { describe, expect, it, vi } from 'vitest';
import type { SubAgentUpdate } from '../../shared/types';
import type { CompletionRequest, LLMProvider, ProviderEvent } from '../providers/types';
import type { ToolPlugin, ToolResult } from '../tools/types';
import { runWorkSubAgent, WriteLockTable, type SubAgentTools } from './subagent';

/** M12-3: work サブエージェントの不変条件を固定する */

function mockProvider(responses: ProviderEvent[][]): LLMProvider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    id: 'anthropic',
    requests,
    async *complete(req: CompletionRequest) {
      requests.push({ ...req, messages: [...req.messages] });
      const next = responses.shift();
      if (!next) throw new Error('モック応答が尽きた');
      yield* next;
    },
  };
}

const done = (
  blocks:
    | { type: 'text'; text: string }[]
    | { type: 'tool_use'; id: string; name: string; input: unknown }[],
  stop: 'end_turn' | 'tool_use',
): ProviderEvent[] => [
  {
    type: 'message_done',
    message: { role: 'assistant', content: blocks },
    stopReason: stop,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
  },
];

function fakeTool(name: string, risk: ToolPlugin['risk'], pathParams?: string[]): ToolPlugin {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    risk,
    ...(pathParams !== undefined ? { pathParams } : {}),
    execute: async () => ({ content: `${name} ok` }),
  };
}

function registryOf(plugins: ToolPlugin[]): SubAgentTools {
  return { list: () => plugins, get: (n) => plugins.find((p) => p.name === n) };
}

const ALL_TOOLS = [
  fakeTool('read_file', 'safe', ['path']),
  fakeTool('write_file', 'write', ['path']),
  fakeTool('bash', 'exec'),
  fakeTool('dispatch_agent', 'safe'),
  fakeTool('request_capability', 'safe'),
  fakeTool('plan', 'safe'),
];

describe('runWorkSubAgent(M12-3)', () => {
  it('work 子には write/exec を含む全ツールが渡るが、ネスト・進化・plan は除外される', async () => {
    const provider = mockProvider([done([{ type: 'text', text: '完了' }], 'end_turn')]);
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok' }));

    await runWorkSubAgent(
      { provider, tools: registryOf(ALL_TOOLS), cwd: '/x', executeTool },
      1,
      'タスク',
      new AbortController().signal,
    );

    const toolNames = provider.requests[0]!.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(['bash', 'read_file', 'write_file']);
  });

  it('子のツール実行は親の executeTool(=executor承認フロー)を subAgentId 付きで経由する', async () => {
    const provider = mockProvider([
      done([{ type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'a.txt' } }], 'tool_use'),
      done([{ type: 'text', text: '書いた' }], 'end_turn'),
    ]);
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok' }));

    const summary = await runWorkSubAgent(
      { provider, tools: registryOf(ALL_TOOLS), cwd: '/x', executeTool },
      7,
      'a.txt を書く',
      new AbortController().signal,
    );

    expect(summary).toBe('書いた');
    expect(executeTool).toHaveBeenCalledTimes(1);
    const [name, , ctx] = executeTool.mock.calls[0] as unknown as [string, unknown, { subAgentId?: number }];
    expect(name).toBe('write_file');
    expect(ctx.subAgentId).toBe(7);
  });

  it('除外ツール(request_capability / dispatch_agent / plan)を子が要求しても実行されない', async () => {
    for (const banned of ['request_capability', 'dispatch_agent', 'plan']) {
      const provider = mockProvider([
        done([{ type: 'tool_use', id: 't1', name: banned, input: {} }], 'tool_use'),
        done([{ type: 'text', text: 'x' }], 'end_turn'),
      ]);
      const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok' }));
      await runWorkSubAgent(
        { provider, tools: registryOf(ALL_TOOLS), cwd: '/x', executeTool },
        1,
        't',
        new AbortController().signal,
      );
      expect(executeTool).not.toHaveBeenCalled();
    }
  });

  it('write 衝突: 同一パスへの write は最初の子が所有し、他の子は isError で拒否される', async () => {
    const locks = new WriteLockTable();
    const makeChild = (id: number): Promise<string> =>
      runWorkSubAgent(
        {
          provider: mockProvider([
            done([{ type: 'tool_use', id: `t${id}`, name: 'write_file', input: { path: 'shared.txt' } }], 'tool_use'),
            done([{ type: 'text', text: `child${id}` }], 'end_turn'),
          ]),
          tools: registryOf(ALL_TOOLS),
          cwd: '/x',
          executeTool: async () => ({ content: 'ok' }),
          locks,
        },
        id,
        't',
        new AbortController().signal,
      );

    // 子1が先に shared.txt を取得
    await makeChild(1);
    // 子2の同一パス write は拒否される(ツール結果がエラーになり、履歴に衝突メッセージが載る)
    const provider2 = mockProvider([
      done([{ type: 'tool_use', id: 't2', name: 'write_file', input: { path: 'SHARED.TXT' } }], 'tool_use'),
      done([{ type: 'text', text: '衝突を確認' }], 'end_turn'),
    ]);
    const executeTool2 = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok' }));
    await runWorkSubAgent(
      { provider: provider2, tools: registryOf(ALL_TOOLS), cwd: '/x', executeTool: executeTool2, locks },
      2,
      't',
      new AbortController().signal,
    );
    expect(executeTool2).not.toHaveBeenCalled(); // 実書き込みまで到達しない
    // 2回目のリクエストの tool_result に衝突メッセージが入っている
    const secondReq = provider2.requests[1]!;
    const resultBlock = secondReq.messages[secondReq.messages.length - 1]!.content[0]!;
    expect(resultBlock.type === 'tool_result' && resultBlock.content).toContain('書き込み衝突');
    expect(resultBlock.type === 'tool_result' && resultBlock.content).toContain('#1');
  });

  it('親 signal の中断で cancelled になり、進行イベントにも反映される', async () => {
    const ac = new AbortController();
    const provider: LLMProvider = {
      id: 'anthropic',
      async *complete(req) {
        await new Promise<void>((res) =>
          req.signal.addEventListener('abort', () => res(), { once: true }),
        );
        throw new Error('aborted');
      },
    };
    const updates: SubAgentUpdate[] = [];
    const p = runWorkSubAgent(
      {
        provider,
        tools: registryOf(ALL_TOOLS),
        cwd: '/x',
        executeTool: async () => ({ content: 'ok' }),
        onUpdate: (u) => updates.push(u),
      },
      3,
      '長い作業',
      ac.signal,
    );
    ac.abort();
    const summary = await p;
    expect(summary).toContain('キャンセル');
    expect(updates[0]!.status).toBe('running');
    expect(updates[updates.length - 1]!.status).toBe('cancelled');
  });

  it('進行イベント: running(currentTool付き)→ done(summaryTail付き)', async () => {
    const provider = mockProvider([
      done([{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } }], 'tool_use'),
      done([{ type: 'text', text: '調査完了です' }], 'end_turn'),
    ]);
    const updates: SubAgentUpdate[] = [];
    await runWorkSubAgent(
      {
        provider,
        tools: registryOf(ALL_TOOLS),
        cwd: '/x',
        executeTool: async () => ({ content: 'ok' }),
        onUpdate: (u) => updates.push(u),
      },
      1,
      't',
      new AbortController().signal,
    );
    expect(updates.some((u) => u.status === 'running' && u.currentTool === 'read_file')).toBe(true);
    const last = updates[updates.length - 1]!;
    expect(last.status).toBe('done');
    expect(last.summaryTail).toContain('調査完了です');
  });
});

describe('WriteLockTable', () => {
  it('同一オーナーの再取得は成功、他オーナーは拒否(大文字小文字非依存)', () => {
    const t = new WriteLockTable();
    expect(t.claim('C:\\ws\\a.txt', 1)).toEqual({ ok: true });
    expect(t.claim('c:\\ws\\A.TXT', 1)).toEqual({ ok: true });
    expect(t.claim('C:\\ws\\a.txt', 2)).toEqual({ ok: false, ownerId: 1 });
    expect(t.claim('C:\\ws\\b.txt', 2)).toEqual({ ok: true });
  });
});
