import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppConfig, EvolutionJobSummary } from '../../shared/types';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import { EventBus } from './events';
import { AgentService, type AgentServiceDeps, type EvolutionHooks } from './service';

/** M23-7: 進化の結果をチャット(人間向けinfo)とモデル(自動指示)へフィードバックする */

const BASE_CONFIG: AppConfig = {
  autoApprove: { safe: true, write: false, exec: false },
  provider: 'anthropic',
  model: '',
  scopeMode: 'project',
};

function echoProvider(text: string): LLMProvider {
  return {
    id: 'anthropic',
    async *complete(): AsyncGenerator<ProviderEvent> {
      yield {
        type: 'message_done',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      };
    },
  };
}

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

function makeService(provider: LLMProvider): {
  svc: AgentService;
  bus: EventBus;
  events: AgentEvent[];
  hooks: () => EvolutionHooks;
} {
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.subscribe('chat:event', (e) => events.push(e));
  let hooks: EvolutionHooks | null = null;
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
      return { list: () => [], enqueue: vi.fn(async () => 1) };
    },
    providerFactory: () => provider,
  } satisfies AgentServiceDeps);
  return {
    svc,
    bus,
    events,
    hooks: () => {
      if (!hooks) throw new Error('createEvolution 未呼び出し');
      return hooks;
    },
  };
}

const waitDone = (bus: EventBus): Promise<void> =>
  new Promise((resolve) => {
    const unsub = bus.subscribe('chat:event', (e) => {
      if (e.kind === 'status' && ['done', 'error', 'cancelled'].includes(e.status)) {
        unsub();
        resolve();
      }
    });
  });

const failedJob = (origin?: string): EvolutionJobSummary => ({
  id: 9,
  description: 'ヘッドレスブラウザツール',
  status: 'failed',
  log: [],
  gates: [
    { name: 'protected', ok: true, detail: '合格' },
    { name: 'smoke', ok: false, detail: 'processes 未注入' },
  ],
  error: '検証ゲート不合格',
  ...(origin !== undefined ? { originConversationId: origin } : {}),
});

describe('進化結果のチャット/モデル通知(M23-7)', () => {
  it('終端状態でinfoカードが1回だけ出る(同状態の重複update抑止)', () => {
    const { events, hooks } = makeService(echoProvider('x'));
    hooks().onEvent({ kind: 'job_update', job: failedJob() });
    hooks().onEvent({ kind: 'job_update', job: failedJob() });
    const infos = events.filter((e) => e.kind === 'info' && e.message.includes('進化ジョブ#9'));
    expect(infos).toHaveLength(1);
    expect(infos[0]!.kind === 'info' && infos[0]!.message).toContain('smokeゲート');
  });

  it('待機中の依頼元会話には履歴へ自動通知が積まれ、モデルが次の送信で読める', async () => {
    const { svc, bus, events, hooks } = makeService(echoProvider('了解'));
    const done = waitDone(bus);
    svc.chatSend('進化を申請して', 'normal');
    await done;
    // ランのクリアは終端イベントの1マイクロタスク後(finally)
    await new Promise((r) => setTimeout(r, 0));
    const convId = svc.getCurrentConversationId();

    hooks().onEvent({ kind: 'job_update', job: failedJob(convId) });

    // 履歴にモデル向けの自動通知が入っている(=次のLLM呼び出しに載る)
    const view = svc.getHistoryView();
    const notice = view.find((m) => m.role === 'user' && m.text.includes('(自動通知)'));
    expect(notice?.text).toContain('processes 未注入');
    expect(notice?.text).toContain('代替手段');
    // UI用の instruction_queued も conversationId 付きで出る
    expect(
      events.some((e) => e.kind === 'instruction_queued' && e.conversationId === convId),
    ).toBe(true);
  });

  it('実行中の依頼元会話にはM21-1キュー経由で注入される(instruction_queued発行)', async () => {
    const { svc, bus, events, hooks } = makeService(hangingProvider());
    const { sessionId } = svc.chatSend('長いタスク', 'normal');
    const convId = svc.getCurrentConversationId();

    const doneJob: EvolutionJobSummary = {
      id: 3,
      description: 'csv変換',
      status: 'done',
      toolName: 'csv_to_markdown',
      log: [],
      gates: [],
      originConversationId: convId,
    };
    hooks().onEvent({ kind: 'job_update', job: doneJob });

    const queued = events.find((e) => e.kind === 'instruction_queued' && e.sessionId === sessionId);
    expect(queued?.kind === 'instruction_queued' && queued.text).toContain('csv_to_markdown');
    expect(queued?.conversationId).toBe(convId);

    const cancelled = waitDone(bus);
    svc.chatCancel(sessionId);
    await cancelled;
  });

  it('依頼元が無い(手動起動)ジョブはinfoのみでモデル注入しない', () => {
    const { svc, events, hooks } = makeService(echoProvider('x'));
    hooks().onEvent({ kind: 'job_update', job: failedJob() });
    expect(events.some((e) => e.kind === 'instruction_queued')).toBe(false);
    expect(svc.getHistoryView()).toHaveLength(0);
  });
});
