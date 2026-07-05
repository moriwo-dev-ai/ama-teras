import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppConfig } from '../../shared/types';
import type { CompletionRequest, LLMProvider, ProviderEvent } from '../providers/types';
import { EventBus } from './events';
import { AgentService, type AgentServiceDeps, type SessionsLike } from './service';
import type { SessionData } from './sessions';

/** M16-1: プロバイダ/モデル切替検知→事前compactionの結線を固定する */

function bigTextProvider(): LLMProvider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    id: 'anthropic',
    requests,
    async *complete(req): AsyncGenerator<ProviderEvent> {
      requests.push(req);
      // 要約要求(tools空+要約system)には要約を返す
      const isSummary = req.tools.length === 0 && req.system.includes('要約');
      yield {
        type: 'message_done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: isSummary ? '## 依頼の目的\n要約済み' : `応答 ${'り'.repeat(3000)}` }],
        },
        stopReason: 'end_turn',
        // 実測トークンを大きく報告し、切替時の閾値(24k)を超えさせる
        usage: { inputTokens: 30_000, outputTokens: 10, cacheReadTokens: 0 },
      };
    },
  };
}

function memorySessions(): SessionsLike & { saved: SessionData[] } {
  const saved: SessionData[] = [];
  const files = new Map<string, SessionData>();
  return {
    saved,
    save: async (d) => {
      const copy = structuredClone(d);
      saved.push(copy);
      files.set(d.id, copy);
    },
    load: async (id) => structuredClone(files.get(id) ?? null),
    list: async () => [],
    delete: async () => {},
  };
}

function makeService(provider: LLMProvider): {
  svc: AgentService;
  bus: EventBus;
  config: AppConfig;
  sessions: ReturnType<typeof memorySessions>;
} {
  const bus = new EventBus();
  const config: AppConfig = {
    autoApprove: { safe: true, write: false, exec: false },
    provider: 'anthropic',
    model: 'model-a',
    scopeMode: 'project',
  };
  const sessions = memorySessions();
  const deps: AgentServiceDeps = {
    bus,
    registry: { list: () => [], get: () => undefined, reload: async () => {}, errors: [] },
    config: { get: () => structuredClone(config) },
    secrets: { get: () => null },
    audit: { append: () => {} },
    defaultWorkspace: () => process.cwd(),
    denyPaths: { userDataDir: '/tmp/x-ud', repoGitDir: '/tmp/x-git' },
    createEvolution: () => ({ list: () => [], enqueue: vi.fn(async () => 1) }),
    providerFactory: () => provider,
    sessions,
  };
  return { svc: new AgentService(deps), bus, config, sessions };
}

function runTurn(svc: AgentService, bus: EventBus, text: string): Promise<AgentEvent[]> {
  return new Promise((resolve) => {
    const seen: AgentEvent[] = [];
    const unsub = bus.subscribe('chat:event', (e) => {
      seen.push(e);
      if (e.kind === 'status' && ['done', 'error'].includes(e.status)) {
        unsub();
        // activeRun クリア(finally)を待ってから返す
        setTimeout(() => resolve(seen), 10);
      }
    });
    svc.chatSend(text, 'normal');
  });
}

describe('M16-1: 切替時compaction', () => {
  it('モデル切替を検知したら初回LLM呼び出し前に圧縮し、infoカードを流す', async () => {
    const provider = bigTextProvider();
    const { svc, bus, config } = makeService(provider);

    // model-a で5ターン: 圧縮対象(直近4ターン保持の手前)がある状態を作る
    for (let i = 0; i < 5; i++) {
      await runTurn(svc, bus, `依頼${i} ${'あ'.repeat(2000)}`);
    }
    const callsAfterFirst = provider.requests.length;

    // モデル切替
    config.model = 'model-b';
    const events = await runTurn(svc, bus, '切替後の依頼');

    const info = events.find((e) => e.kind === 'info');
    expect(info && info.kind === 'info' && info.message).toContain('モデル切替を検知');
    expect(info && info.kind === 'info' && info.message).toContain('model-a');
    expect(info && info.kind === 'info' && info.message).toContain('model-b');
    expect(info && info.kind === 'info' && info.message).toContain('圧縮しました');
    // 圧縮の要約呼び出しが挟まっている(通常応答より1回多い)
    const summaryCalls = provider.requests.slice(callsAfterFirst).filter(
      (r) => r.tools.length === 0 && r.system.includes('要約'),
    );
    expect(summaryCalls.length).toBeGreaterThanOrEqual(1);
    // 履歴の先頭が要約に置換されている
    const view = svc.getHistoryView();
    expect(view[0]!.text).toContain('要約');
  });

  it('同一モデル継続では発火しない(infoなし・要約呼び出しなし)', async () => {
    const provider = bigTextProvider();
    const { svc, bus } = makeService(provider);
    await runTurn(svc, bus, `一回目 ${'あ'.repeat(2000)}`);
    const before = provider.requests.length;
    const events = await runTurn(svc, bus, '二回目(同一モデル)');
    expect(events.some((e) => e.kind === 'info')).toBe(false);
    const summaryCalls = provider.requests.slice(before).filter(
      (r) => r.tools.length === 0 && r.system.includes('要約'),
    );
    expect(summaryCalls).toHaveLength(0);
  });

  it('lastLLM がセッションに保存され、ロードで復元される(復元後の同一モデルは非発火)', async () => {
    const provider = bigTextProvider();
    const { svc, bus, sessions } = makeService(provider);
    await runTurn(svc, bus, '保存テスト');
    await new Promise((r) => setTimeout(r, 20));

    const saved = sessions.saved[sessions.saved.length - 1]!;
    expect(saved.lastLLM).toEqual({ provider: 'anthropic', model: 'model-a' });

    // ロード → 同一モデルで続き → 切替扱いにならない
    svc.sessionNew();
    await svc.sessionLoad(saved.id);
    const events = await runTurn(svc, bus, '復元後の続き');
    expect(events.some((e) => e.kind === 'info')).toBe(false);
  });
});
