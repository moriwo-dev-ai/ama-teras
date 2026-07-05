import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppConfig } from '../../shared/types';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import type { ScopeAuditEvent } from '../tools/executor';
import { EventBus } from './events';
import { AgentService, type AgentServiceDeps } from './service';

/** M16-2: AgentService のフォールバック配線(1会話1回・audit・disabled時停止)を固定 */

function billingProvider(): LLMProvider {
  return {
    id: 'anthropic',
    // eslint-disable-next-line require-yield
    async *complete(): AsyncGenerator<ProviderEvent> {
      throw new Error('400 Your credit balance is too low to access the Anthropic API');
    },
  };
}

function okProvider(text: string): LLMProvider {
  return {
    id: 'openai',
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

function makeService(opts: { fallbackEnabled: boolean }): {
  svc: AgentService;
  bus: EventBus;
  audits: ScopeAuditEvent[];
  fallbackFactory: ReturnType<typeof vi.fn>;
} {
  const bus = new EventBus();
  const audits: ScopeAuditEvent[] = [];
  const config: AppConfig = {
    autoApprove: { safe: true, write: false, exec: false },
    provider: 'anthropic',
    model: 'claude-x',
    scopeMode: 'project',
    ...(opts.fallbackEnabled
      ? { fallback: { enabled: true, provider: 'openai' as const, model: 'gpt-fb' } }
      : {}),
  };
  const fallbackFactory = vi.fn(() => okProvider('フォールバック応答'));
  const deps: AgentServiceDeps = {
    bus,
    registry: { list: () => [], get: () => undefined, reload: async () => {}, errors: [] },
    config: { get: () => structuredClone(config) },
    secrets: { get: () => null },
    audit: { append: (e) => audits.push(e) },
    defaultWorkspace: () => process.cwd(),
    denyPaths: { userDataDir: '/tmp/x-ud', repoGitDir: '/tmp/x-git' },
    createEvolution: () => ({ list: () => [], enqueue: vi.fn(async () => 1) }),
    providerFactory: () => billingProvider(),
    fallbackProviderFactory: fallbackFactory,
  };
  return { svc: new AgentService(deps), bus, audits, fallbackFactory };
}

function runTurn(svc: AgentService, bus: EventBus, text: string): Promise<AgentEvent[]> {
  return new Promise((resolve) => {
    const seen: AgentEvent[] = [];
    const unsub = bus.subscribe('chat:event', (e) => {
      seen.push(e);
      if (e.kind === 'status' && ['done', 'error'].includes(e.status)) {
        unsub();
        setTimeout(() => resolve(seen), 10);
      }
    });
    svc.chatSend(text, 'normal');
  });
}

describe('M16-2: フォールバック(service配線)', () => {
  it('billingエラー→フォールバック発動(警告カード+audit)→doneまで続行', async () => {
    const { svc, bus, audits, fallbackFactory } = makeService({ fallbackEnabled: true });
    const events = await runTurn(svc, bus, '実行して');

    expect(events.some((e) => e.kind === 'status' && e.status === 'done')).toBe(true);
    expect(fallbackFactory).toHaveBeenCalledWith('openai', 'gpt-fb');
    const warn = events.find((e) => e.kind === 'info' && e.message.includes('フォールバック'));
    expect(warn && warn.kind === 'info' && warn.message).toContain('openai/gpt-fb');
    const audit = audits.find((a) => a.tool === 'provider-fallback');
    expect(audit?.detail).toContain('anthropic/claude-x → openai/gpt-fb');
    // 履歴にフォールバック先の応答が入っている
    expect(svc.getHistoryView().some((m) => m.text.includes('フォールバック応答'))).toBe(true);
  });

  it('同一会話での2回目は発動せず error 停止(往復ループ禁止)', async () => {
    const { svc, bus, fallbackFactory } = makeService({ fallbackEnabled: true });
    await runTurn(svc, bus, '1回目');
    const events = await runTurn(svc, bus, '2回目(また残高切れ)');
    expect(fallbackFactory).toHaveBeenCalledTimes(1); // 増えない
    expect(events.some((e) => e.kind === 'status' && e.status === 'error')).toBe(true);
  });

  it('新しい会話(sessionNew)ではまた1回使える', async () => {
    const { svc, bus, fallbackFactory } = makeService({ fallbackEnabled: true });
    await runTurn(svc, bus, '会話1');
    svc.sessionNew();
    const events = await runTurn(svc, bus, '会話2');
    expect(fallbackFactory).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.kind === 'status' && e.status === 'done')).toBe(true);
  });

  it('disabled(既定)ではフォールバックせず従来どおり error 停止', async () => {
    const { svc, bus, fallbackFactory, audits } = makeService({ fallbackEnabled: false });
    const events = await runTurn(svc, bus, '実行して');
    expect(fallbackFactory).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === 'status' && e.status === 'error')).toBe(true);
    expect(audits).toHaveLength(0);
  });
});
