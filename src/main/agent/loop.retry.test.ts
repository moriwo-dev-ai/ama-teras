import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../shared/types';
import type { CompletionRequest, LLMProvider, ProviderEvent } from '../providers/types';
import { runAgentLoop, type AgentLoopDeps } from './loop';

/** M16-2: 一時エラーのリトライと課金系フォールバックのループ挙動を固定する */

const okEvent: ProviderEvent = {
  type: 'message_done',
  message: { role: 'assistant', content: [{ type: 'text', text: '成功' }] },
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
};

/** 呼び出しごとに throwするエラー or 成功を script で指定するプロバイダ */
function scripted(script: (unknown | 'ok')[]): LLMProvider & { calls: number } {
  const state = { calls: 0 };
  return {
    id: 'anthropic',
    get calls() {
      return state.calls;
    },
    // eslint-disable-next-line require-yield
    async *complete(_req: CompletionRequest): AsyncGenerator<ProviderEvent> {
      const step = script[Math.min(state.calls, script.length - 1)];
      state.calls++;
      if (step === 'ok') {
        yield okEvent;
        return;
      }
      throw step;
    },
  };
}

function deps(provider: LLMProvider, overrides?: Partial<AgentLoopDeps>): { d: AgentLoopDeps; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const d: AgentLoopDeps = {
    provider,
    tools: { list: () => [] },
    executeTool: async () => ({ content: 'ok' }),
    emit: (e) => events.push(e),
    systemPrompt: 'sys',
    cwd: process.cwd(),
    retry: { baseMs: 1 }, // テスト高速化
    ...overrides,
  };
  return { d, events };
}

const err529 = Object.assign(new Error('Overloaded'), { status: 529 });
const errBilling = new Error('400 Your credit balance is too low to access the Anthropic API');

describe('M16-2: transientリトライ', () => {
  it('529→529→成功: リトライして done になり、infoカードが2枚出る', async () => {
    const provider = scripted([err529, err529, 'ok']);
    const { d, events } = deps(provider);
    const status = await runAgentLoop(d, 's1', [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], new AbortController().signal);
    expect(status).toBe('done');
    expect(provider.calls).toBe(3);
    const infos = events.filter((e) => e.kind === 'info');
    expect(infos).toHaveLength(2);
    expect(infos[0]!.kind === 'info' && infos[0]!.message).toContain('再試行');
  });

  it('transientが続く場合は最大3回で諦めて error', async () => {
    const provider = scripted([err529]);
    const { d, events } = deps(provider);
    const status = await runAgentLoop(d, 's1', [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], new AbortController().signal);
    expect(status).toBe('error');
    expect(provider.calls).toBe(4); // 初回 + リトライ3回
    expect(events.some((e) => e.kind === 'error')).toBe(true);
  });

  it('バックオフ待機中の abort は cancelled', async () => {
    const provider = scripted([err529]);
    const ac = new AbortController();
    const { d } = deps(provider, { retry: { baseMs: 5000 } });
    const p = runAgentLoop(d, 's1', [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], ac.signal);
    setTimeout(() => ac.abort(), 50);
    expect(await p).toBe('cancelled');
  });
});

describe('M16-2: 課金系フォールバック', () => {
  it('billingエラーで acquireFallback が呼ばれ、返ったプロバイダで同一ターンを続行する', async () => {
    const primary = scripted([errBilling]);
    const fallback = scripted(['ok']);
    const acquire = vi.fn(async (reason: string) => {
      expect(reason).toContain('credit balance');
      return fallback;
    });
    const { d, events } = deps(primary, { acquireFallback: acquire });
    const status = await runAgentLoop(d, 's1', [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], new AbortController().signal);
    expect(status).toBe('done');
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(primary.calls).toBe(1); // billingはリトライしない
    expect(fallback.calls).toBe(1);
    expect(events.some((e) => e.kind === 'error')).toBe(false);
  });

  it('acquireFallback が null なら従来どおり error 停止(リトライもしない)', async () => {
    const primary = scripted([errBilling]);
    const acquire = vi.fn(async () => null);
    const { d, events } = deps(primary, { acquireFallback: acquire });
    const status = await runAgentLoop(d, 's1', [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], new AbortController().signal);
    expect(status).toBe('error');
    expect(primary.calls).toBe(1);
    expect(events.some((e) => e.kind === 'error')).toBe(true);
  });

  it('acquireFallback 未設定(従来構成)でも挙動は従来どおり error', async () => {
    const primary = scripted([errBilling]);
    const { d } = deps(primary);
    const status = await runAgentLoop(d, 's1', [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], new AbortController().signal);
    expect(status).toBe('error');
  });
});
