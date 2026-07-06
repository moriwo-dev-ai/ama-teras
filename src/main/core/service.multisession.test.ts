import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppConfig, ApprovalRequestPayload, SessionMeta } from '../../shared/types';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import type { SessionData } from './sessions';
import { EventBus } from './events';
import { AgentService, type AgentServiceDeps } from './service';

/** M22: 複数会話の同時実行 — 独立性・イベント帰属・キャンセル分離・承認origin・軟性しきい値 */

const BASE_CONFIG: AppConfig = {
  autoApprove: { safe: true, write: false, exec: false },
  provider: 'anthropic',
  model: '',
  scopeMode: 'project',
};

/** abort まで固まるプロバイダ */
function hangingProvider(): LLMProvider {
  return {
    id: 'anthropic',
    async *complete(req): AsyncGenerator<ProviderEvent> {
      await new Promise<void>((res) =>
        req.signal.addEventListener('abort', () => res(), { once: true }),
      );
      throw new Error('aborted');
    },
  };
}

/** 一言返して終わるプロバイダ */
function echoProvider(text: string): LLMProvider {
  return {
    id: 'anthropic',
    async *complete(): AsyncGenerator<ProviderEvent> {
      yield { type: 'text_delta', text };
      yield {
        type: 'message_done',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      };
    },
  };
}

function memorySessions(): {
  saved: Map<string, SessionData>;
  store: NonNullable<AgentServiceDeps['sessions']>;
} {
  const saved = new Map<string, SessionData>();
  return {
    saved,
    store: {
      save: async (d) => {
        saved.set(d.id, structuredClone(d));
      },
      load: async (id) => saved.get(id) ?? null,
      list: async () =>
        [...saved.values()].map(
          (d): SessionMeta => ({
            id: d.id,
            title: d.title,
            workspace: d.workspace,
            createdAt: d.createdAt,
            updatedAt: d.updatedAt,
            messageCount: d.history.length,
          }),
        ),
      delete: async (id) => {
        saved.delete(id);
      },
    },
  };
}

function makeService(
  providers: LLMProvider[],
  overrides?: Partial<AgentServiceDeps>,
): { svc: AgentService; bus: EventBus; events: AgentEvent[] } {
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.subscribe('chat:event', (e) => events.push(e));
  const svc = new AgentService({
    bus,
    registry: { list: () => [], get: () => undefined, reload: async () => {}, errors: [] },
    config: { get: () => structuredClone(BASE_CONFIG) },
    secrets: { get: () => null },
    audit: { append: () => {} },
    defaultWorkspace: () => process.cwd(),
    denyPaths: { userDataDir: '/tmp/x-userdata', repoGitDir: '/tmp/x-git' },
    createEvolution: () => ({ list: () => [], enqueue: vi.fn(async () => 1) }),
    providerFactory: () => {
      const p = providers.shift();
      if (!p) throw new Error('プロバイダが尽きた');
      return p;
    },
    ...overrides,
  });
  return { svc, bus, events };
}

function waitFor(bus: EventBus, pred: (e: AgentEvent) => boolean): Promise<AgentEvent> {
  return new Promise((resolve) => {
    const unsub = bus.subscribe('chat:event', (e) => {
      if (pred(e)) {
        unsub();
        resolve(e);
      }
    });
  });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('AgentService M22(複数会話の同時実行)', () => {
  it('2会話が同時に走り、historyとイベントのconversationIdが分離される', async () => {
    const { store } = memorySessions();
    const { svc, bus, events } = makeService([hangingProvider(), echoProvider('B完了')], {
      sessions: store,
    });

    // 会話A: 固まるラン
    const a = svc.chatSend('タスクA', 'normal');
    const convA = svc.getCurrentConversationId();
    expect(svc.runsList()).toHaveLength(1);

    // 実行中でも新規会話Bを開始できる
    expect(svc.sessionNew().ok).toBe(true);
    const doneB = waitFor(bus, (e) => e.kind === 'status' && e.status === 'done');
    const b = svc.chatSend('タスクB', 'normal');
    const convB = svc.getCurrentConversationId();
    expect(convB).not.toBe(convA);
    expect(svc.runsList()).toHaveLength(2);

    await doneB;
    await tick();
    // Bの完了後もAは生きている
    expect(svc.runsList().map((r) => r.sessionId)).toEqual([a.sessionId]);
    // Bの履歴は独立(Aのhistoryに混ざらない)
    expect(svc.getHistoryView()).toEqual([
      { role: 'user', text: 'タスクB' },
      { role: 'assistant', text: 'B完了' },
    ]);
    // イベントの帰属: Bのtext_deltaはconvB、Aのイベント(status)はconvA
    const deltaB = events.find((e) => e.kind === 'text_delta');
    expect(deltaB?.conversationId).toBe(convB);
    expect(
      events.filter((e) => e.sessionId === a.sessionId).every((e) => e.conversationId === convA),
    ).toBe(true);
    expect(
      events.filter((e) => e.sessionId === b.sessionId).every((e) => e.conversationId === convB),
    ).toBe(true);

    // 会話Aのcancelは会話Bに影響しない(Bは完了済み・Aだけ止まる)
    const cancelledA = waitFor(bus, (e) => e.kind === 'status' && e.status === 'cancelled');
    svc.chatCancel(a.sessionId);
    await cancelledA;
    await tick();
    expect(svc.runsList()).toHaveLength(0);

    // 並行persist: 両会話がそれぞれのファイルに保存されている
    const metas = await store.list();
    expect(metas.map((m) => m.id).sort()).toEqual([convA, convB].sort());
  });

  it('実行中の会話を開き直すと running 情報つきで生きたhistoryに接続する', async () => {
    const { store } = memorySessions();
    const { svc, bus } = makeService([hangingProvider()], { sessions: store });
    const a = svc.chatSend('走り続けるタスク', 'normal');
    const convA = svc.getCurrentConversationId();

    svc.sessionNew();
    expect(svc.getStatus().activeSessionId).toBeNull();

    const back = await svc.sessionLoad(convA);
    expect(back.ok).toBe(true);
    expect(back.conversationId).toBe(convA);
    expect(back.running?.sessionId).toBe(a.sessionId);
    expect(svc.getStatus().activeSessionId).toBe(a.sessionId);

    const cancelled = waitFor(bus, (e) => e.kind === 'status' && e.status === 'cancelled');
    svc.chatCancel(a.sessionId);
    await cancelled;
  });

  it('M22: 承認要求に origin(会話ID・タイトル・workspace)が付く', async () => {
    const writeTool = {
      name: 'write_file',
      description: 'w',
      risk: 'write' as const,
      inputSchema: { type: 'object' as const, properties: {} },
      execute: async () => ({ content: 'ok' }),
    };
    const provider: LLMProvider = {
      id: 'anthropic',
      async *complete(req): AsyncGenerator<ProviderEvent> {
        if (req.messages.length === 1) {
          yield {
            type: 'message_done',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'a.txt' } }],
            },
            stopReason: 'tool_use',
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
          };
          return;
        }
        yield {
          type: 'message_done',
          message: { role: 'assistant', content: [{ type: 'text', text: '了解' }] },
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
        };
      },
    };
    const bus = new EventBus();
    const requests: ApprovalRequestPayload[] = [];
    bus.subscribe('approval:request', (r) => requests.push(r));
    const svc = new AgentService({
      bus,
      registry: {
        list: () => [writeTool],
        get: (n) => (n === 'write_file' ? writeTool : undefined),
        reload: async () => {},
        errors: [],
      },
      config: { get: () => structuredClone(BASE_CONFIG) },
      secrets: { get: () => null },
      audit: { append: () => {} },
      defaultWorkspace: () => process.cwd(),
      denyPaths: { userDataDir: '/tmp/x-userdata', repoGitDir: '/tmp/x-git' },
      createEvolution: () => ({ list: () => [], enqueue: vi.fn(async () => 1) }),
      providerFactory: () => provider,
    });
    const done = new Promise<void>((resolve) => {
      const unsub = bus.subscribe('chat:event', (e) => {
        if (e.kind === 'status' && ['done', 'error', 'cancelled'].includes(e.status)) {
          unsub();
          resolve();
        }
      });
    });
    svc.chatSend('ファイルを書いて', 'normal');
    const convId = svc.getCurrentConversationId();
    // 承認要求が来るまで待つ
    while (requests.length === 0) await tick();
    expect(requests[0]!.origin).toEqual({
      conversationId: convId,
      title: 'ファイルを書いて',
      workspace: process.cwd(),
    });
    svc.approvalRespond(requests[0]!.id, 'deny');
    await done;
  });

  it('M17-2×M22: 自律モードは会話単位(切替でOFF・元の会話に戻ると維持されている)', async () => {
    const { svc, bus } = makeService([hangingProvider()]);
    svc.setAutonomous(true);
    const a = svc.chatSend('自律タスク', 'normal');
    const convA = svc.getCurrentConversationId();
    expect(svc.getAutonomous()).toBe(true);

    // 新規会話へ切替 → 新規はOFF(事故防止)
    svc.sessionNew();
    expect(svc.getAutonomous()).toBe(false);

    // 実行中の会話Aへ戻ると自律モードは維持されている(実行中の自律ランを壊さない)
    const back = await svc.sessionLoad(convA);
    expect(back.autonomous).toBe(true);
    expect(svc.getAutonomous()).toBe(true);

    const cancelled = waitFor(bus, (e) => e.kind === 'status' && e.status === 'cancelled');
    svc.chatCancel(a.sessionId);
    await cancelled;
  });

  it('軟性しきい値: 同時6ラン目で警告infoカード(ハード上限は無い)', async () => {
    const providers = Array.from({ length: 6 }, () => hangingProvider());
    const { svc, bus, events } = makeService(providers);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      if (i > 0) svc.sessionNew();
      ids.push(svc.chatSend(`並行タスク${i + 1}`, 'normal').sessionId);
    }
    // 6本全部が受理されて実行中(ハード上限なし)
    expect(svc.runsList()).toHaveLength(6);
    // 6本目で軟性しきい値の警告が出ている
    expect(
      events.some((e) => e.kind === 'info' && e.message.includes('同時実行が6件')),
    ).toBe(true);

    const allCancelled = Promise.all(
      ids.map((id) =>
        waitFor(bus, (e) => e.kind === 'status' && e.status === 'cancelled' && e.sessionId === id),
      ),
    );
    for (const id of ids) svc.chatCancel(id);
    await allCancelled;
  });
});
