import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppConfig, EvolutionJobSummary } from '../../shared/types';
import type { ChatMessage, LLMProvider, ProviderEvent } from '../providers/types';
import { EventBus } from './events';
import {
  AgentService,
  toHistoryView,
  type AgentServiceDeps,
  type EvolutionHooks,
} from './service';

const BASE_CONFIG: AppConfig = {
  autoApprove: { safe: true, write: false, exec: false },
  provider: 'anthropic',
  model: '',
  scopeMode: 'project',
};

function makeService(overrides?: Partial<AgentServiceDeps>): {
  svc: AgentService;
  bus: EventBus;
  hooks: () => EvolutionHooks;
  enqueue: ReturnType<typeof vi.fn>;
} {
  const bus = new EventBus();
  let hooks: EvolutionHooks | null = null;
  const enqueue = vi.fn(async () => 42);
  const svc = new AgentService({
    bus,
    registry: { list: () => [], get: () => undefined, reload: async () => {}, errors: [] },
    config: { get: () => structuredClone(BASE_CONFIG) },
    secrets: { get: () => null },
    audit: { append: () => {} },
    defaultWorkspace: () => process.cwd(),
    denyPaths: { userDataDir: '/tmp/x-userdata', repoGitDir: '/tmp/x-git' },
    createEvolution: (h) => {
      hooks = h;
      return { list: () => [], enqueue };
    },
    ...overrides,
  });
  return {
    svc,
    bus,
    hooks: () => {
      if (!hooks) throw new Error('createEvolution が呼ばれていない');
      return hooks;
    },
    enqueue,
  };
}

/** 指定 kind のイベントが来るまで待つ */
function waitForStatus(bus: EventBus, statuses: string[]): Promise<AgentEvent> {
  return new Promise((resolve) => {
    const unsub = bus.subscribe('chat:event', (e) => {
      if (e.kind === 'status' && statuses.includes(e.status)) {
        unsub();
        resolve(e);
      }
    });
  });
}

describe('AgentService: chat', () => {
  it('APIキー未設定の chatSend は error と status:error をバスへ流す', () => {
    const { svc, bus } = makeService();
    const seen: AgentEvent[] = [];
    bus.subscribe('chat:event', (e) => seen.push(e));
    const { sessionId } = svc.chatSend('こんにちは', 'normal');
    expect(sessionId).toBeTruthy();
    expect(seen).toEqual([
      { kind: 'error', sessionId, message: 'Anthropic APIキーが未設定(設定画面から登録)' },
      { kind: 'status', sessionId, status: 'error' },
    ]);
    expect(svc.getStatus().status).toBe('idle');
  });

  it('実行中の chatSend は「別の実行が進行中」になり、cancel で終了する', async () => {
    const provider: LLMProvider = {
      id: 'anthropic',
      async *complete(req) {
        await new Promise<void>((res) =>
          req.signal.addEventListener('abort', () => res(), { once: true }),
        );
        throw new Error('aborted');
      },
    };
    const { svc, bus } = makeService({ providerFactory: () => provider });
    const seen: AgentEvent[] = [];
    bus.subscribe('chat:event', (e) => seen.push(e));

    const { sessionId } = svc.chatSend('long task', 'normal');
    expect(svc.getStatus().activeSessionId).toBe(sessionId);

    const second = svc.chatSend('another', 'normal');
    expect(
      seen.some(
        (e) => e.kind === 'error' && e.sessionId === second.sessionId && e.message === '別の実行が進行中',
      ),
    ).toBe(true);

    // M11-2: セッションキャンセルでバックグラウンドプロセスが全て kill される
    const killAll = vi.spyOn(svc.processes, 'killAll');
    const done = waitForStatus(bus, ['cancelled']);
    svc.chatCancel(sessionId);
    await done;
    expect(killAll).toHaveBeenCalled();
    // activeRun のクリアは終端イベントの1マイクロタスク後(finally)なので1tick待つ
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.getStatus()).toEqual({ status: 'idle', activeSessionId: null, scopeMode: 'project', autonomous: false });
  });

  it('正常応答が履歴ビューに反映され、status が idle に戻る', async () => {
    const provider: LLMProvider = {
      id: 'anthropic',
      async *complete(): AsyncGenerator<ProviderEvent> {
        yield { type: 'text_delta', text: 'やあ' };
        yield {
          type: 'message_done',
          message: { role: 'assistant', content: [{ type: 'text', text: 'やあ' }] },
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
        };
      },
    };
    const { svc, bus } = makeService({ providerFactory: () => provider });
    const done = waitForStatus(bus, ['done', 'error']);
    svc.chatSend('挨拶して', 'normal');
    const last = await done;
    expect(last).toMatchObject({ kind: 'status', status: 'done' });
    expect(svc.getHistoryView()).toEqual([
      { role: 'user', text: '挨拶して' },
      { role: 'assistant', text: 'やあ' },
    ]);
  });
});

describe('AgentService: maxTurns 配線(M11-1)', () => {
  it('config.maxTurns がループへ渡り、上限到達で max_turns_reached になる', async () => {
    const plugin = {
      name: 'noop',
      description: 'テスト用',
      risk: 'safe' as const,
      inputSchema: { type: 'object' as const, properties: {} },
      execute: async () => ({ content: 'ok' }),
    };
    let calls = 0;
    // 毎ターン tool_use を返し続けるプロバイダ(自然終了しない)
    const provider: LLMProvider = {
      id: 'anthropic',
      async *complete(): AsyncGenerator<ProviderEvent> {
        calls++;
        yield {
          type: 'message_done',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: `t${calls}`, name: 'noop', input: {} }],
          },
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
        };
      },
    };
    const { svc, bus } = makeService({
      providerFactory: () => provider,
      registry: {
        list: () => [plugin],
        get: (n) => (n === 'noop' ? plugin : undefined),
        reload: async () => {},
        errors: [],
      },
      config: { get: () => ({ ...structuredClone(BASE_CONFIG), maxTurns: 2 }) },
    });
    const done = waitForStatus(bus, ['max_turns_reached', 'done', 'error']);
    svc.chatSend('自走して', 'normal');
    const last = await done;
    expect(last).toMatchObject({ kind: 'status', status: 'max_turns_reached' });
    expect(calls).toBe(2); // 未設定なら30まで回る(loop.test.ts の既定値テストと対)
  });
});

describe('AgentService: チェックポイント配線(M11-3)', () => {
  const mkPlugin = (name: string, risk: 'safe' | 'write' | 'exec') => ({
    name,
    description: 'テスト用',
    risk,
    inputSchema: { type: 'object' as const, properties: {} },
    execute: async () => ({ content: 'ok' }),
  });

  it('write 成功後とループ完了時に snapshot、safe ツールでは呼ばれない', async () => {
    const snapshots: { sessionId: string; label: string }[] = [];
    const fake = {
      workspace: process.cwd(),
      snapshot: async (sessionId: string, label: string) => {
        snapshots.push({ sessionId, label });
        return 'f'.repeat(40);
      },
      list: async () => [],
      restore: async () => ({ ok: true, message: '' }),
    };
    const plugins = [mkPlugin('write_x', 'write'), mkPlugin('read_x', 'safe')];
    let turn = 0;
    const provider: LLMProvider = {
      id: 'anthropic',
      async *complete(): AsyncGenerator<ProviderEvent> {
        turn++;
        if (turn === 1) {
          yield {
            type: 'message_done',
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 't1', name: 'write_x', input: {} },
                { type: 'tool_use', id: 't2', name: 'read_x', input: {} },
              ],
            },
            stopReason: 'tool_use',
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
          };
        } else {
          yield {
            type: 'message_done',
            message: { role: 'assistant', content: [{ type: 'text', text: '完了' }] },
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
          };
        }
      },
    };
    const { svc, bus } = makeService({
      providerFactory: () => provider,
      registry: {
        list: () => plugins,
        get: (n) => plugins.find((p) => p.name === n),
        reload: async () => {},
        errors: [],
      },
      config: {
        get: () => ({
          ...structuredClone(BASE_CONFIG),
          autoApprove: { safe: true, write: true, exec: true },
        }),
      },
      createCheckpoints: () => fake,
    });
    const done = waitForStatus(bus, ['done', 'error']);
    const { sessionId } = svc.chatSend('書いて', 'normal');
    await done;
    // done ステータス後の loop 完了スナップショットまで待つ(finally の1tick)
    await new Promise((r) => setTimeout(r, 0));
    expect(snapshots).toEqual([
      { sessionId, label: 'write_x 実行後' },
      { sessionId, label: 'セッション終了(done)' },
    ]);
  });

  it('createCheckpoints 未指定なら list は空・restore は無効メッセージ(完全noop)', async () => {
    const { svc } = makeService();
    expect(await svc.checkpointList()).toEqual([]);
    const r = await svc.checkpointRestore('a'.repeat(40));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('無効');
  });
});

describe('AgentService: 承認の追跡', () => {
  it('承認要求は pending に載り、respond で approval:resolved が流れて消える', async () => {
    const { svc, bus } = makeService();
    const requests: string[] = [];
    const resolved: { id: string; decision: string }[] = [];
    bus.subscribe('approval:request', (r) => requests.push(r.id));
    bus.subscribe('approval:resolved', (r) => resolved.push(r));

    const decisionP = svc.broker.request({
      toolName: 'write_file',
      risk: 'write',
      inputPreview: '{}',
      warnings: [],
    });
    expect(requests).toHaveLength(1);
    const id = requests[0];
    if (!id) throw new Error('承認要求idが取れない');
    expect(svc.getPendingApprovals().map((p) => p.id)).toEqual([id]);

    svc.approvalRespond(id, 'allow');
    expect(await decisionP).toBe('allow');
    expect(resolved).toEqual([{ id, decision: 'allow' }]);
    expect(svc.getPendingApprovals()).toEqual([]);
  });

  it('abort による deny 解決でも approval:resolved が流れる(取り残し防止)', async () => {
    const { svc, bus } = makeService();
    const resolved: string[] = [];
    bus.subscribe('approval:resolved', (r) => resolved.push(r.decision));
    const ac = new AbortController();
    const p = svc.broker.request(
      { toolName: 'bash', risk: 'exec', inputPreview: '{}', warnings: [] },
      ac.signal,
    );
    ac.abort();
    expect(await p).toBe('deny');
    expect(resolved).toEqual(['deny']);
    expect(svc.getPendingApprovals()).toEqual([]);
  });
});

describe('AgentService: 進化', () => {
  const jobStub: EvolutionJobSummary = {
    id: 7,
    description: 'テスト',
    status: 'awaiting_promotion',
    toolName: 'new_tool',
    log: [],
    gates: [],
  };

  it('昇格要求はイベントと pending に載り、respond で解決する', async () => {
    const { svc, bus, hooks } = makeService();
    const events: unknown[] = [];
    bus.subscribe('evolution:event', (e) => events.push(e));

    const approvedP = hooks().requestPromotionApproval(jobStub, 'diff-text', ['警告']);
    expect(events).toEqual([
      { kind: 'promotion_request', jobId: 7, toolName: 'new_tool', diff: 'diff-text', warnings: ['警告'] },
    ]);
    expect(svc.getPendingPromotionRequests().map((e) => e.jobId)).toEqual([7]);

    svc.evolutionPromoteRespond(7, true);
    expect(await approvedP).toBe(true);
    expect(svc.getPendingPromotionRequests()).toEqual([]);
  });

  it('enqueue は EvolutionManager へ委譲される', async () => {
    const { svc, enqueue } = makeService();
    const { jobId } = await svc.evolutionEnqueue('説明', '入出力');
    expect(jobId).toBe(42);
    expect(enqueue).toHaveBeenCalledWith({ description: '説明', expectedIO: '入出力' });
  });
});

describe('toHistoryView', () => {
  it('テキストと tool_use を整形し、tool_result のみのメッセージは省く', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'CSVを変換して' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '読み込みます' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'a,b' }] },
      { role: 'assistant', content: [{ type: 'text', text: '完了' }] },
    ];
    expect(toHistoryView(messages)).toEqual([
      { role: 'user', text: 'CSVを変換して' },
      { role: 'assistant', text: '読み込みます\n⚙ read_file' },
      { role: 'assistant', text: '完了' },
    ]);
  });
});

describe('AgentService: ツール一覧', () => {
  it('toolsList はプラグインを ToolInfo へ写像する', () => {
    const { svc } = makeService({
      registry: {
        list: () => [
          {
            name: 'demo',
            description: 'デモ',
            risk: 'safe',
            warnings: ['注意'],
            inputSchema: { type: 'object', properties: {} },
            execute: async () => ({ content: 'ok' }),
          },
        ],
        get: () => undefined,
        reload: async () => {},
        errors: [{ filePath: 'x.ts', message: '壊れてる' }],
      },
    });
    expect(svc.toolsList()).toEqual({
      tools: [{ name: 'demo', description: 'デモ', risk: 'safe', warnings: ['注意'] }],
      errors: [{ filePath: 'x.ts', message: '壊れてる' }],
    });
  });
});
