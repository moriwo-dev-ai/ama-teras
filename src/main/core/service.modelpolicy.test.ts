import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppConfig, ModelPolicy, ProviderId } from '../../shared/types';
import type { CompletionRequest, LLMProvider, ProviderEvent } from '../providers/types';
import { EventBus } from './events';
import { AgentService, type AgentServiceDeps, type ModelBandName } from './service';

/**
 * M18: modelPolicy(役割ベースのモデル自動切替)の service 配線を固定する。
 * - 無効(未設定/enabled:false)では従来の単一モデル経路のまま(帯生成は呼ばれない)
 * - 有効ならメイン会話= planner 帯
 * - worker/escalation 帯のキー未登録は実行前に警告カード
 * - 進化ジョブ用 createProviderOrThrow は policy の影響を受けない
 */

const POLICY: ModelPolicy = {
  enabled: true,
  planner: { provider: 'anthropic', model: 'claude-fable-5' },
  worker: { provider: 'openai', model: 'gpt-5.1' },
  maxEscalationsPerTask: 1,
};

function textProvider(id: ProviderId, text: string): LLMProvider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    id,
    requests,
    async *complete(req: CompletionRequest): AsyncGenerator<ProviderEvent> {
      requests.push(req);
      yield {
        type: 'message_done',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      };
    },
  };
}

function makeService(opts: {
  policy?: ModelPolicy;
  secrets?: (p: ProviderId) => string | null;
  bandProviderFactory?: AgentServiceDeps['bandProviderFactory'];
  providerFactory?: () => LLMProvider | string;
  registry?: AgentServiceDeps['registry'];
}): { svc: AgentService; bus: EventBus; events: AgentEvent[] } {
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.subscribe('chat:event', (e) => events.push(e));
  const config: AppConfig = {
    autoApprove: { safe: true, write: false, exec: false },
    provider: 'anthropic',
    model: '',
    scopeMode: 'project',
    ...(opts.policy !== undefined ? { modelPolicy: opts.policy } : {}),
  };
  const svc = new AgentService({
    bus,
    registry: opts.registry ?? { list: () => [], get: () => undefined, reload: async () => {}, errors: [] },
    config: { get: () => structuredClone(config) },
    secrets: { get: opts.secrets ?? (() => 'test-key') },
    audit: { append: () => {} },
    defaultWorkspace: () => process.cwd(),
    denyPaths: { userDataDir: '/tmp/x-userdata', repoGitDir: '/tmp/x-git' },
    createEvolution: () => ({ list: () => [], enqueue: vi.fn(async () => 1) }),
    ...(opts.bandProviderFactory !== undefined ? { bandProviderFactory: opts.bandProviderFactory } : {}),
    ...(opts.providerFactory !== undefined ? { providerFactory: opts.providerFactory } : {}),
  });
  return { svc, bus, events };
}

function waitForTerminal(bus: EventBus): Promise<void> {
  return new Promise((resolve) => {
    const unsub = bus.subscribe('chat:event', (e) => {
      if (e.kind === 'status' && ['done', 'error', 'cancelled', 'max_turns_reached'].includes(e.status)) {
        unsub();
        resolve();
      }
    });
  });
}

describe('M18: modelPolicy の service 配線', () => {
  it('無効(未設定)では従来経路(providerFactory)を使い、帯生成は呼ばれない', async () => {
    const main = textProvider('anthropic', '従来どおり');
    const bandFactory = vi.fn();
    const { svc, bus } = makeService({
      providerFactory: () => main,
      bandProviderFactory: bandFactory as never,
    });
    const terminal = waitForTerminal(bus);
    svc.chatSend('こんにちは', 'normal');
    await terminal;
    expect(main.requests).toHaveLength(1);
    expect(bandFactory).not.toHaveBeenCalled();
  });

  it('有効ならメイン会話は planner 帯のプロバイダで動く', async () => {
    const planner = textProvider('anthropic', 'plannerが応答');
    const worker = textProvider('openai', 'worker');
    const calls: [ModelBandName, ProviderId, string][] = [];
    const { svc, bus } = makeService({
      policy: POLICY,
      bandProviderFactory: (band, provider, model) => {
        calls.push([band, provider, model]);
        return band === 'planner' ? planner : worker;
      },
    });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;

    expect(planner.requests).toHaveLength(1); // メインは planner 帯
    expect(worker.requests).toHaveLength(0); // dispatch していないので worker は未使用
    expect(calls).toContainEqual(['planner', 'anthropic', 'claude-fable-5']);
    expect(calls).toContainEqual(['worker', 'openai', 'gpt-5.1']);
    // escalation 未指定 → planner 帯が格上げ先として解決される
    expect(calls).toContainEqual(['escalation', 'anthropic', 'claude-fable-5']);
  });

  it('worker 帯のキー未登録は警告カードを出し、メインは planner で続行する', async () => {
    const planner = textProvider('anthropic', '応答');
    const { svc, bus, events } = makeService({
      policy: POLICY, // worker は openai
      secrets: (p) => (p === 'anthropic' ? 'key' : null),
      bandProviderFactory: () => planner,
    });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;

    const warns = events.filter((e) => e.kind === 'info').map((e) => (e as { message: string }).message);
    expect(warns.some((m) => m.includes('worker帯') && m.includes('APIキーが未設定'))).toBe(true);
    expect(planner.requests).toHaveLength(1); // 止まらない
  });

  it('planner 帯のキー未登録は従来のキー未設定エラーと同様に停止する', () => {
    const { svc, events } = makeService({
      policy: POLICY,
      secrets: () => null,
    });
    svc.chatSend('やって', 'normal');
    expect(
      events.some(
        (e) => e.kind === 'error' && e.message.includes('planner帯') && e.message.includes('未設定'),
      ),
    ).toBe(true);
  });

  it('M26-3: dispatch_agent(mode:"read"相当の単発調査)は explorer 帯で走る', async () => {
    const { default: dispatchAgent } = await import('../tools/plugins/dispatch_agent');
    const planner = textProvider('anthropic', ''); // 下で差し替え
    const explorer = textProvider('anthropic', '調査済み');
    const worker = textProvider('anthropic', 'worker');
    // planner は dispatch_agent を1回呼んでから完了する
    const plannerRequests: CompletionRequest[] = planner.requests;
    let turn = 0;
    const plannerProvider: LLMProvider = {
      id: 'anthropic',
      async *complete(req: CompletionRequest): AsyncGenerator<ProviderEvent> {
        plannerRequests.push(req);
        turn++;
        yield {
          type: 'message_done',
          message:
            turn === 1
              ? {
                  role: 'assistant',
                  content: [{ type: 'tool_use', id: 't1', name: 'dispatch_agent', input: { task: '調べて' } }],
                }
              : { role: 'assistant', content: [{ type: 'text', text: '完了' }] },
          stopReason: turn === 1 ? 'tool_use' : 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
        };
      },
    };
    const reg = [dispatchAgent];
    const { svc, bus } = makeService({
      policy: {
        ...POLICY,
        explorer: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      },
      registry: {
        list: () => reg,
        get: (n) => reg.find((p) => p.name === n),
        reload: async () => {},
        errors: [],
      },
      bandProviderFactory: (band) =>
        band === 'planner' ? plannerProvider : band === 'explorer' ? explorer : worker,
    });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;

    expect(explorer.requests.length).toBeGreaterThan(0); // 調査は explorer 帯
    expect(worker.requests).toHaveLength(0); // worker には流れない
  });

  it('guardrail: createProviderOrThrow(進化ジョブ経路)は policy の影響を受けない', () => {
    const marker = textProvider('anthropic', 'evolution');
    const bandFactory = vi.fn();
    const { svc } = makeService({
      policy: POLICY,
      providerFactory: () => marker,
      bandProviderFactory: bandFactory as never,
    });
    expect(svc.createProviderOrThrow()).toBe(marker);
    expect(bandFactory).not.toHaveBeenCalled();
  });
});
