import { describe, expect, it } from 'vitest';
import type { ModelPolicy, OperationsConfig } from '../../shared/types';
import { resolveOperationsLLM } from './bands';

/**
 * M34-7: 運営専用モデル帯の解決(テスト必須: 未設定時のフォールバック・設定時の帯解決)。
 * 背景: 神議はplanner帯で1日2回動き運営コストの大半を占めるため、本体と独立に選べる。
 * 既定の推奨: kamuhakari=Sonnet系(分析品質と単価のバランス)、gods=worker帯のまま
 * (判定・下書きは軽量で十分。この推奨は設定UIの説明文にも記載)
 */

const policy: ModelPolicy = {
  enabled: true,
  planner: { provider: 'anthropic', model: 'claude-fable-5' },
  worker: { provider: 'anthropic', model: 'claude-haiku-4-5' },
};

const ops = (over: Partial<OperationsConfig>): OperationsConfig => ({
  enabled: true,
  repos: [],
  zennSlugs: [],
  ...over,
});

describe('M34-7: resolveOperationsLLM', () => {
  it('明示帯が最優先(神議をSonnetへ、神々はそのまま)', () => {
    const cfg = ops({ kamuhakariBand: { provider: 'anthropic', model: 'claude-sonnet-5' } });
    expect(resolveOperationsLLM(cfg, policy, 'kamuhakari')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    // gods は未設定 → policy の worker 帯へフォールバック
    expect(resolveOperationsLLM(cfg, policy, 'gods')).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    });
  });

  it('未設定時のフォールバック: kamuhakari→planner / gods→worker', () => {
    expect(resolveOperationsLLM(ops({}), policy, 'kamuhakari')?.model).toBe('claude-fable-5');
    expect(resolveOperationsLLM(ops({}), policy, 'gods')?.model).toBe('claude-haiku-4-5');
    expect(resolveOperationsLLM(undefined, policy, 'kamuhakari')?.model).toBe('claude-fable-5');
  });

  it('ModelPolicy無効かつ明示帯なし → null(単一モデル設定で代行)', () => {
    expect(resolveOperationsLLM(ops({}), null, 'kamuhakari')).toBeNull();
  });

  it('明示帯の空モデルはプロバイダ既定へ', () => {
    const cfg = ops({ godsBand: { provider: 'openai', model: '' } });
    const resolved = resolveOperationsLLM(cfg, null, 'gods');
    expect(resolved?.provider).toBe('openai');
    expect(resolved?.model).not.toBe('');
  });
});
