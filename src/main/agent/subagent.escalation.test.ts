import { describe, expect, it, vi } from 'vitest';
import type { SubAgentUpdate } from '../../shared/types';
import type { CompletionRequest, LLMProvider, ProviderEvent } from '../providers/types';
import type { ToolPlugin, ToolResult } from '../tools/types';
import { runWorkSubAgent, type SubAgentTools, type WorkSubAgentDeps } from './subagent';

/**
 * M18: work サブエージェントのエスカレーション(格上げ)を固定する。
 * - status error / maxTurns到達 / ツール失敗3連続 で escalation 帯へ引き継ぐ
 * - 格上げ前に compact が呼ばれ、格上げ先には子履歴(tool_use/tool_result ペア)がそのまま渡る
 * - maxPerTask で打ち止め(escalation 帯でも失敗したら通常のエラー扱い)
 */

function mockProvider(
  id: 'anthropic' | 'openai',
  responses: ProviderEvent[][],
): LLMProvider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    id,
    requests,
    async *complete(req: CompletionRequest) {
      requests.push({ ...req, messages: req.messages.map((m) => ({ ...m, content: [...m.content] })) });
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

/** モデル応答が空 → loop は 'error' で終わる(モック用の最短の失敗) */
const emptyResponse = (): ProviderEvent[] =>
  done([] as { type: 'text'; text: string }[], 'end_turn');

function fakeTool(name: string, risk: ToolPlugin['risk']): ToolPlugin {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    risk,
    execute: async () => ({ content: `${name} ok` }),
  };
}

function registryOf(plugins: ToolPlugin[]): SubAgentTools {
  return { list: () => plugins, get: (n) => plugins.find((p) => p.name === n) };
}

const TOOLS = [fakeTool('write_file', 'write'), fakeTool('bash', 'exec')];

function escalateDeps(
  provider: LLMProvider,
  maxPerTask = 1,
): { deps: NonNullable<WorkSubAgentDeps['escalate']>; compact: ReturnType<typeof vi.fn>; onEscalate: ReturnType<typeof vi.fn> } {
  const compact = vi.fn(async () => {});
  const onEscalate = vi.fn();
  return { deps: { provider, maxPerTask, compact, onEscalate }, compact, onEscalate };
}

describe('M18: エスカレーション', () => {
  it('worker が error で終わったら escalation 帯へ格上げして完遂する(compact経由・履歴引き継ぎ)', async () => {
    const worker = mockProvider('openai', [emptyResponse()]);
    const esc = mockProvider('anthropic', [done([{ type: 'text', text: '格上げで完了' }], 'end_turn')]);
    const { deps, compact, onEscalate } = escalateDeps(esc);
    const updates: SubAgentUpdate[] = [];

    const summary = await runWorkSubAgent(
      {
        provider: worker,
        tools: registryOf(TOOLS),
        cwd: '/x',
        executeTool: async (): Promise<ToolResult> => ({ content: 'ok' }),
        onUpdate: (u) => updates.push(u),
        escalate: deps,
      },
      1,
      'タスク',
      new AbortController().signal,
    );

    expect(summary).toContain('格上げで完了');
    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(onEscalate.mock.calls[0]).toEqual([1, 1, 'status: error']);
    expect(compact).toHaveBeenCalledTimes(1);
    // 格上げ先には元のタスクと「自動格上げ」指示を含む履歴が渡る
    const escMessages = esc.requests[0]!.messages;
    expect(escMessages[0]!.content[0]).toMatchObject({ type: 'text', text: 'タスク' });
    expect(JSON.stringify(escMessages)).toContain('自動格上げ');
    // 完了時の update に escalated が立つ
    const final = updates[updates.length - 1]!;
    expect(final).toMatchObject({ status: 'done', escalated: true });
  });

  it('ツール失敗が3連続すると、doneで終わっても格上げされる(トリガー(c))', async () => {
    // worker: 3回 tool_use → 各回 isError → その後 done で終わる
    const worker = mockProvider('openai', [
      done([{ type: 'tool_use', id: 't1', name: 'bash', input: {} }], 'tool_use'),
      done([{ type: 'tool_use', id: 't2', name: 'bash', input: {} }], 'tool_use'),
      done([{ type: 'tool_use', id: 't3', name: 'bash', input: {} }], 'tool_use'),
      done([{ type: 'text', text: '直せなかったが終わる' }], 'end_turn'),
    ]);
    const esc = mockProvider('anthropic', [done([{ type: 'text', text: '上位モデルが修復' }], 'end_turn')]);
    const { deps, onEscalate } = escalateDeps(esc);

    const summary = await runWorkSubAgent(
      {
        provider: worker,
        tools: registryOf(TOOLS),
        cwd: '/x',
        executeTool: async (): Promise<ToolResult> => ({ content: '失敗', isError: true }),
        escalate: deps,
      },
      2,
      'タスク',
      new AbortController().signal,
    );

    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(onEscalate.mock.calls[0]![2]).toContain('3連続');
    expect(summary).toContain('上位モデルが修復');
  });

  it('途中で成功を挟むと連続カウントはリセットされ、格上げされない', async () => {
    const worker = mockProvider('openai', [
      done([{ type: 'tool_use', id: 't1', name: 'bash', input: {} }], 'tool_use'),
      done([{ type: 'tool_use', id: 't2', name: 'bash', input: {} }], 'tool_use'),
      done([{ type: 'tool_use', id: 't3', name: 'bash', input: {} }], 'tool_use'),
      done([{ type: 'text', text: '完了' }], 'end_turn'),
    ]);
    const esc = mockProvider('anthropic', []);
    const { deps, onEscalate } = escalateDeps(esc);
    let call = 0;

    const summary = await runWorkSubAgent(
      {
        provider: worker,
        tools: registryOf(TOOLS),
        cwd: '/x',
        // 2回失敗 → 1回成功(リセット)→ 以降失敗なし
        executeTool: async (): Promise<ToolResult> =>
          ++call <= 2 ? { content: '失敗', isError: true } : { content: 'ok' },
        escalate: deps,
      },
      3,
      'タスク',
      new AbortController().signal,
    );

    expect(summary).toBe('完了');
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it('maxPerTask 到達後は escalation 帯でも失敗なら通常のエラー扱い(無限格上げしない)', async () => {
    const worker = mockProvider('openai', [emptyResponse()]);
    const esc = mockProvider('anthropic', [emptyResponse()]); // 格上げ先も失敗
    const { deps, onEscalate } = escalateDeps(esc, 1);
    const updates: SubAgentUpdate[] = [];

    const summary = await runWorkSubAgent(
      {
        provider: worker,
        tools: registryOf(TOOLS),
        cwd: '/x',
        executeTool: async (): Promise<ToolResult> => ({ content: 'ok' }),
        onUpdate: (u) => updates.push(u),
        escalate: deps,
      },
      4,
      'タスク',
      new AbortController().signal,
    );

    expect(onEscalate).toHaveBeenCalledTimes(1); // 2回目は無い
    expect(updates[updates.length - 1]!.status).toBe('error');
    expect(summary).toContain('要約を返さなかった');
  });

  it('escalate 未指定(policy無効)では従来どおり格上げしない', async () => {
    const worker = mockProvider('openai', [emptyResponse()]);
    const summary = await runWorkSubAgent(
      {
        provider: worker,
        tools: registryOf(TOOLS),
        cwd: '/x',
        executeTool: async (): Promise<ToolResult> => ({ content: 'ok' }),
      },
      5,
      'タスク',
      new AbortController().signal,
    );
    expect(summary).toContain('要約を返さなかった');
    expect(worker.requests).toHaveLength(1);
  });

  it('プロバイダ横断: openai(worker)の tool_use/tool_result ペアが anthropic(escalation)へ中立形式のまま渡る', async () => {
    const worker = mockProvider('openai', [
      done([{ type: 'tool_use', id: 'tu-1', name: 'write_file', input: { path: 'a.txt' } }], 'tool_use'),
      emptyResponse(), // 2ターン目で失敗 → 格上げ
    ]);
    const esc = mockProvider('anthropic', [done([{ type: 'text', text: '引き継いだ' }], 'end_turn')]);
    const { deps } = escalateDeps(esc);

    await runWorkSubAgent(
      {
        provider: worker,
        tools: registryOf(TOOLS),
        cwd: '/x',
        executeTool: async (): Promise<ToolResult> => ({ content: '書き込み成功' }),
        escalate: deps,
      },
      6,
      'a.txt を作る',
      new AbortController().signal,
    );

    // escalation 側が受け取った履歴で tool_use と tool_result の対応が崩れていない
    const msgs = esc.requests[0]!.messages;
    const blocks = msgs.flatMap((m) => m.content);
    const uses = blocks.filter((b) => b.type === 'tool_use');
    const results = blocks.filter((b) => b.type === 'tool_result');
    expect(uses).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect((results[0] as { toolUseId: string }).toolUseId).toBe('tu-1');
    expect((uses[0] as { id: string }).id).toBe('tu-1');
  });
});
