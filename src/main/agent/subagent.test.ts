import { describe, expect, it, vi } from 'vitest';
import type { CompletionRequest, LLMProvider, ProviderEvent } from '../providers/types';
import type { ToolPlugin } from '../tools/types';
import { runAgentLoop } from './loop';
import { runSubAgent, type SubAgentTools } from './subagent';

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

const done = (blocks: { type: 'text'; text: string }[] | { type: 'tool_use'; id: string; name: string; input: unknown }[], stop: 'end_turn' | 'tool_use'): ProviderEvent[] => [
  {
    type: 'message_done',
    message: { role: 'assistant', content: blocks },
    stopReason: stop,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
  },
];

function fakeTool(name: string, risk: ToolPlugin['risk'], exec: () => Promise<{ content: string; isError?: boolean }>): ToolPlugin {
  return { name, description: name, inputSchema: { type: 'object', properties: {} }, risk, execute: exec };
}

function fakeRegistry(plugins: ToolPlugin[]): SubAgentTools {
  return { list: () => plugins, get: (n) => plugins.find((p) => p.name === n) };
}

describe('runSubAgent(M8-4)', () => {
  it('子は読み取り専用ツールを使い、最後の要約テキストだけを返す', async () => {
    const grepExec = vi.fn(async () => ({ content: 'a.ts:1: match' }));
    const registry = fakeRegistry([
      fakeTool('grep', 'safe', grepExec),
      fakeTool('write_file', 'write', async () => ({ content: 'wrote' })),
    ]);
    const provider = mockProvider([
      done([{ type: 'tool_use', id: 't1', name: 'grep', input: { pattern: 'x' } }], 'tool_use'),
      done([{ type: 'text', text: '結論: a.ts の1行目に該当あり' }], 'end_turn'),
    ]);

    const summary = await runSubAgent({ provider, tools: registry, cwd: '/x' }, 'xを探して', new AbortController().signal);

    expect(grepExec).toHaveBeenCalledTimes(1);
    expect(summary).toBe('結論: a.ts の1行目に該当あり');
    // 子に渡ったツール定義に write_file(非safe)は含まれない
    expect(provider.requests[0]!.tools.map((t) => t.name)).toEqual(['grep']);
  });

  it('plan(risk:safe だが書き込みアクションを持つ)は子に渡らない(M12-2)', async () => {
    const planExec = vi.fn(async () => ({ content: 'plan' }));
    const registry = fakeRegistry([
      fakeTool('grep', 'safe', async () => ({ content: 'ok' })),
      fakeTool('plan', 'safe', planExec),
    ]);
    const provider = mockProvider([
      done([{ type: 'tool_use', id: 't1', name: 'plan', input: { action: 'write' } }], 'tool_use'),
      done([{ type: 'text', text: '完了' }], 'end_turn'),
    ]);

    await runSubAgent({ provider, tools: registry, cwd: '/x' }, 'x', new AbortController().signal);

    expect(provider.requests[0]!.tools.map((t) => t.name)).toEqual(['grep']);
    expect(planExec).not.toHaveBeenCalled(); // 要求しても実行されない
  });

  it('子が非safeツールを要求しても実行を拒否する(読み取り専用の担保)', async () => {
    const writeExec = vi.fn(async () => ({ content: 'wrote' }));
    const registry = fakeRegistry([
      fakeTool('grep', 'safe', async () => ({ content: 'ok' })),
      fakeTool('write_file', 'write', writeExec),
    ]);
    const provider = mockProvider([
      done([{ type: 'tool_use', id: 'w1', name: 'write_file', input: {} }], 'tool_use'),
      done([{ type: 'text', text: '要約' }], 'end_turn'),
    ]);

    await runSubAgent({ provider, tools: registry, cwd: '/x' }, 'file書いて', new AbortController().signal);
    expect(writeExec).not.toHaveBeenCalled(); // 書き込みは実行されない
  });
});

describe('親履歴の非肥大化(M8-4完了条件)', () => {
  it('子が何回ツールを往復しても、親履歴には dispatch の1往復しか増えない', async () => {
    // 子: grep→read→read→要約(4ターン)。親: dispatch_agent呼び出し→最終応答(2ターン)。
    const registry = fakeRegistry([
      fakeTool('grep', 'safe', async () => ({ content: 'hit' })),
      fakeTool('read_file', 'safe', async () => ({ content: 'contents' })),
    ]);
    const provider = mockProvider([
      // 親ターン1: dispatch_agent を呼ぶ
      done([{ type: 'tool_use', id: 'd1', name: 'dispatch_agent', input: { task: '調べて' } }], 'tool_use'),
      // 子ターン(複数往復)
      done([{ type: 'tool_use', id: 'c1', name: 'grep', input: {} }], 'tool_use'),
      done([{ type: 'tool_use', id: 'c2', name: 'read_file', input: {} }], 'tool_use'),
      done([{ type: 'tool_use', id: 'c3', name: 'read_file', input: {} }], 'tool_use'),
      done([{ type: 'text', text: '子の要約: 3箇所該当' }], 'end_turn'),
      // 親ターン2: 最終応答
      done([{ type: 'text', text: '調査結果を踏まえて完了' }], 'end_turn'),
    ]);

    const parentHistory = [{ role: 'user' as const, content: [{ type: 'text' as const, text: '調べて実装して' }] }];
    const status = await runAgentLoop(
      {
        provider,
        tools: { list: () => [registry.get('grep')!, registry.get('read_file')!] },
        executeTool: async (name, input, ctx) => {
          if (name === 'dispatch_agent') {
            const summary = await runSubAgent({ provider, tools: registry, cwd: '/x' }, String((input as { task: string }).task), ctx.signal);
            return { content: summary };
          }
          return registry.get(name)!.execute(input, ctx);
        },
        emit: () => {},
        systemPrompt: 'parent',
        cwd: '/x',
      },
      'parent',
      parentHistory,
      new AbortController().signal,
    );

    expect(status).toBe('done');
    // 親履歴: user(元) → assistant(tool_use dispatch) → user(tool_result 要約) → assistant(最終) = 4件のみ。
    // 子のgrep/read往復(本来なら+6メッセージ相当)は入っていない。
    expect(parentHistory).toHaveLength(4);
    // tool_result には子の「要約」だけが入り、生ログは含まれない
    const toolResult = parentHistory[2]!.content[0] as unknown as { type: string; content: string };
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.content).toBe('子の要約: 3箇所該当');
    expect(JSON.stringify(parentHistory)).not.toContain('c1'); // 子のtool_use idは親に無い
  });
});
