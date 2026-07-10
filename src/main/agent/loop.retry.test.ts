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

describe('M26-4: セーフガード拒否(refusal)フォールバック', () => {
  const refusalEvent = (content: { type: 'text'; text: string }[] = []): ProviderEvent => ({
    type: 'message_done',
    message: { role: 'assistant', content },
    stopReason: 'refusal',
    usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0 },
  });

  /** 呼び出しごとに指定イベント列を流すプロバイダ */
  function eventScripted(script: ProviderEvent[][]): LLMProvider & { calls: number } {
    const state = { calls: 0 };
    return {
      id: 'anthropic',
      get calls() {
        return state.calls;
      },
      async *complete(_req: CompletionRequest): AsyncGenerator<ProviderEvent> {
        const step = script[Math.min(state.calls, script.length - 1)]!;
        state.calls++;
        yield* step;
      },
    };
  }

  it("refusal で acquireFallback が kind='refusal' 付きで呼ばれ、代替プロバイダで同一ターンをやり直す", async () => {
    const primary = eventScripted([[refusalEvent()]]);
    const fallback = eventScripted([[okEvent]]);
    const acquire = vi.fn(async (_reason: string, kind?: string) => {
      expect(kind).toBe('refusal');
      return fallback;
    });
    const { d, events } = deps(primary, { acquireFallback: acquire });
    const status = await runAgentLoop(d, 's1', [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], new AbortController().signal);
    expect(status).toBe('done');
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(events.some((e) => e.kind === 'error')).toBe(false);
    expect(events.some((e) => e.kind === 'info' && e.message.includes('拒否'))).toBe(true);
  });

  it('部分出力つき(mid-stream)の refusal でもフォールバックで同一ターンをやり直す', async () => {
    const primary = eventScripted([[refusalEvent([{ type: 'text', text: '途中まで…' }])]]);
    const fallback = eventScripted([[okEvent]]);
    const acquire = vi.fn(async () => fallback);
    const { d } = deps(primary, { acquireFallback: acquire });
    const status = await runAgentLoop(d, 's1', [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], new AbortController().signal);
    expect(status).toBe('done');
    expect(fallback.calls).toBe(1);
  });

  it('acquireFallback が null(上限・未設定相当)なら error 停止し、理由がセーフガードだと分かる', async () => {
    const primary = eventScripted([[refusalEvent()]]);
    const acquire = vi.fn(async () => null);
    const { d, events } = deps(primary, { acquireFallback: acquire });
    const status = await runAgentLoop(d, 's1', [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], new AbortController().signal);
    expect(status).toBe('error');
    expect(
      events.some((e) => e.kind === 'error' && e.message.includes('セーフガード')),
    ).toBe(true);
  });

  it('acquireFallback 未設定の従来構成では refusal は従来どおり error 停止', async () => {
    const primary = eventScripted([[refusalEvent()]]);
    const { d, events } = deps(primary);
    const status = await runAgentLoop(d, 's1', [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], new AbortController().signal);
    expect(status).toBe('error');
    expect(events.some((e) => e.kind === 'error')).toBe(true);
  });
});

describe('M27-1: describeLLMError(停止時エラーの平易化フック)', () => {
  it('フックが文字列を返せば error イベントの文言が差し替わる', async () => {
    const err429 = Object.assign(new Error('429 Too Many Requests'), { status: 429 });
    const provider = scripted([err429]);
    const { d, events } = deps(provider, {
      describeLLMError: () => '無料枠の上限に達しました(テスト文言)',
    });
    const status = await runAgentLoop(d, 's1', [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], new AbortController().signal);
    expect(status).toBe('error');
    const errEvent = events.find((e) => e.kind === 'error');
    expect(errEvent?.kind === 'error' && errEvent.message).toBe('無料枠の上限に達しました(テスト文言)');
  });

  it('フックが null を返せば従来どおり生のエラーメッセージ', async () => {
    const err429 = Object.assign(new Error('429 raw error'), { status: 429 });
    const provider = scripted([err429]);
    const { d, events } = deps(provider, { describeLLMError: () => null });
    await runAgentLoop(d, 's1', [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], new AbortController().signal);
    const errEvent = events.find((e) => e.kind === 'error');
    expect(errEvent?.kind === 'error' && errEvent.message).toBe('429 raw error');
  });
});
