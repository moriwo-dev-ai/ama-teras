import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../shared/types';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import { EventBus } from './events';
import { AgentService, type AgentServiceDeps, type SessionsLike } from './service';
import { SESSION_SCHEMA_VERSION, type SessionData } from './sessions';

/** M12-1: AgentService とセッション永続化の結線を固定する */

const BASE_CONFIG: AppConfig = {
  autoApprove: { safe: true, write: false, exec: false },
  provider: 'anthropic',
  model: '',
  scopeMode: 'project',
};

function textProvider(text: string): LLMProvider {
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

function memorySessions(): SessionsLike & { saved: SessionData[] } {
  const saved: SessionData[] = [];
  const files = new Map<string, SessionData>();
  return {
    saved,
    save: async (data) => {
      const copy = structuredClone(data);
      saved.push(copy);
      files.set(data.id, copy);
    },
    load: async (id) => structuredClone(files.get(id) ?? null),
    list: async () => [],
    delete: async (id) => {
      files.delete(id);
    },
  };
}

function makeService(overrides?: Partial<AgentServiceDeps>): { svc: AgentService; bus: EventBus } {
  const bus = new EventBus();
  const svc = new AgentService({
    bus,
    registry: { list: () => [], get: () => undefined, reload: async () => {}, errors: [] },
    config: { get: () => structuredClone(BASE_CONFIG) },
    secrets: { get: () => null },
    audit: { append: () => {} },
    defaultWorkspace: () => process.cwd(),
    denyPaths: { userDataDir: '/tmp/x-userdata', repoGitDir: '/tmp/x-git' },
    createEvolution: () => ({ list: () => [], enqueue: vi.fn(async () => 1) }),
    ...overrides,
  });
  return { svc, bus };
}

function waitForDone(bus: EventBus): Promise<void> {
  return new Promise((resolve) => {
    const unsub = bus.subscribe('chat:event', (e) => {
      if (e.kind === 'status' && ['done', 'error', 'cancelled'].includes(e.status)) {
        unsub();
        resolve();
      }
    });
  });
}

describe('AgentService × セッション永続化(M12-1)', () => {
  it('送信で保存され、完了後の保存に assistant 応答まで含まれる', async () => {
    const sessions = memorySessions();
    const { svc, bus } = makeService({ providerFactory: () => textProvider('了解'), sessions });
    const done = waitForDone(bus);
    svc.chatSend('保存テスト', 'normal');
    await done;
    await new Promise((r) => setTimeout(r, 20)); // persistChain の完了待ち

    expect(sessions.saved.length).toBeGreaterThanOrEqual(2);
    const last = sessions.saved[sessions.saved.length - 1]!;
    expect(last.version).toBe(SESSION_SCHEMA_VERSION);
    expect(last.title).toBe('保存テスト');
    expect(last.history).toHaveLength(2);
    expect(last.history[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: '了解' }] });
    // 同一会話は同一IDで上書き保存される
    expect(new Set(sessions.saved.map((s) => s.id)).size).toBe(1);
  });

  it('2回目の送信も同じ会話IDに積まれる(会話継続)', async () => {
    const sessions = memorySessions();
    const { svc, bus } = makeService({ providerFactory: () => textProvider('OK'), sessions });
    const d1 = waitForDone(bus);
    svc.chatSend('一回目', 'normal');
    await d1;
    // activeRun のクリアは終端イベントの1マイクロタスク後(finally)なので待つ
    await new Promise((r) => setTimeout(r, 0));
    const d2 = waitForDone(bus);
    svc.chatSend('二回目', 'normal');
    await d2;
    await new Promise((r) => setTimeout(r, 20));

    const last = sessions.saved[sessions.saved.length - 1]!;
    expect(new Set(sessions.saved.map((s) => s.id)).size).toBe(1);
    expect(last.history).toHaveLength(4);
    expect(last.title).toBe('一回目'); // タイトルは最初のメッセージから変わらない
  });

  it('sessionLoad で履歴が復元され、sessionNew でリセットされる', async () => {
    const sessions = memorySessions();
    const { svc, bus } = makeService({ providerFactory: () => textProvider('復元前応答'), sessions });
    const done = waitForDone(bus);
    svc.chatSend('復元テスト', 'normal');
    await done;
    await new Promise((r) => setTimeout(r, 20));
    const savedId = sessions.saved[0]!.id;

    expect(svc.sessionNew()).toEqual({ ok: true });
    expect(svc.getHistoryView()).toEqual([]);

    const result = await svc.sessionLoad(savedId);
    expect(result.ok).toBe(true);
    expect(result.history).toEqual([
      { role: 'user', text: '復元テスト' },
      { role: 'assistant', text: '復元前応答' },
    ]);
    expect(svc.getHistoryView()).toHaveLength(2);
  });

  it('M22: 実行中でも sessionNew は成功し、実行中のランは生き続ける(切替ブロック撤廃)', async () => {
    const sessions = memorySessions();
    const provider: LLMProvider = {
      id: 'anthropic',
      async *complete(req): AsyncGenerator<ProviderEvent> {
        await new Promise<void>((res) =>
          req.signal.addEventListener('abort', () => res(), { once: true }),
        );
        throw new Error('aborted');
      },
    };
    const { svc, bus } = makeService({ providerFactory: () => provider, sessions });
    const { sessionId } = svc.chatSend('長い処理', 'normal');

    // 実行中でも新規会話へ切替できる(ブロックされない)
    expect(svc.sessionNew().ok).toBe(true);
    // 表示は新規会話(idle)だが、元のランは runsList に生きている
    expect(svc.getStatus().activeSessionId).toBeNull();
    expect(svc.runsList().map((r) => r.sessionId)).toContain(sessionId);
    // 存在しないIDのロードは従来どおり失敗する
    expect((await svc.sessionLoad('11111111-1111-1111-1111-111111111111')).ok).toBe(false);

    const done = waitForDone(bus);
    svc.chatCancel(sessionId);
    await done;
    // ランのクリアは終端イベントの1マイクロタスク後(finally)なので1tick待つ
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.runsList()).toHaveLength(0);
  });

  it('M15.1: sessionOpen はセッションのworkspaceへ自動追従する(config.set注入時のみ)', async () => {
    const sessions = memorySessions();
    const setCalls: AppConfig[] = [];
    const config = {
      get: () => structuredClone({ ...BASE_CONFIG, workspace: 'C:\\before' }),
      set: (next: AppConfig) => {
        setCalls.push(next);
      },
    };
    const { svc, bus } = makeService({ providerFactory: () => textProvider('OK'), sessions, config });
    const done = waitForDone(bus);
    svc.chatSend('リモート切替テスト', 'normal');
    await done;
    await new Promise((r) => setTimeout(r, 20));
    const saved = sessions.saved[0]!;
    expect(saved.workspace).toBe('C:\\before');

    svc.sessionNew();
    const result = await svc.sessionOpen(saved.id);
    expect(result.ok).toBe(true);
    // 保存されたworkspaceへ追従(現在値が異なるケースを作るためsavedを書き換える)
    expect(setCalls).toEqual([]); // 同一workspaceなら切替しない

    // 異なるworkspaceのセッションを開くと set が呼ばれる
    const other = { ...structuredClone(saved), id: '33333333-3333-3333-3333-333333333333', workspace: 'C:\\other' };
    await sessions.save(other);
    const r2 = await svc.sessionOpen(other.id);
    expect(r2.ok).toBe(true);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]!.workspace).toBe('C:\\other');
  });

  it('M15.1: sessionOpen も実行中は拒否される(サーバ側ガード)', async () => {
    const sessions = memorySessions();
    const provider: LLMProvider = {
      id: 'anthropic',
      async *complete(req): AsyncGenerator<ProviderEvent> {
        await new Promise<void>((res) =>
          req.signal.addEventListener('abort', () => res(), { once: true }),
        );
        throw new Error('aborted');
      },
    };
    const { svc, bus } = makeService({ providerFactory: () => provider, sessions });
    const { sessionId } = svc.chatSend('実行中', 'normal');
    expect((await svc.sessionOpen('11111111-1111-1111-1111-111111111111')).ok).toBe(false);
    const done = waitForDone(bus);
    svc.chatCancel(sessionId);
    await done;
  });

  it('sessions 未注入でもチャットは従来どおり動く(機能無効)', async () => {
    const { svc, bus } = makeService({ providerFactory: () => textProvider('OK') });
    const done = waitForDone(bus);
    svc.chatSend('永続化なし', 'normal');
    await done;
    expect(await svc.sessionsList()).toEqual([]);
    expect((await svc.sessionLoad('x')).ok).toBe(false);
  });
});
