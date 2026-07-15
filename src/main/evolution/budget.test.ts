import { describe, expect, it } from 'vitest';
import { GenerationBudget } from './budget';

/**
 * M92-追加: 予算ガード(累積キャップ2層)。守りたいのは「リトライの積み重ねが静かに
 * Fable 5 週枠を食い潰す」ことの防止。スパイクではなく**累計**で止める。
 */

describe('GenerationBudget', () => {
  it('上限未設定なら無制限(既定=従来どおり動く)', () => {
    const b = new GenerationBudget();
    expect(b.check(0, 1_000_000).ok).toBe(true);
    b.record(1_000_000);
    expect(b.check(999_999_999, 1).ok).toBe(true);
  });

  it('ジョブ単位キャップ: 1本の暴走を止める', () => {
    const b = new GenerationBudget({ perJobTokens: 10_000 });
    expect(b.check(0, 8_000).ok).toBe(true); // まだ余裕
    expect(b.check(8_000, 3_000).ok).toBe(false); // 8k+3k=11k > 10k → 打ち切り
    expect(b.check(8_000, 3_000).reason).toContain('ジョブのトークン上限');
  });

  it('セッション/夜間キャップ: 生成全体の合計で止める(Fable 5 枠の保護)', () => {
    const b = new GenerationBudget({ sessionTokens: 20_000 });
    b.record(15_000); // 別ジョブで既に消費
    expect(b.check(0, 4_000).ok).toBe(true); // 15k+4k=19k ≤ 20k
    expect(b.check(0, 6_000).ok).toBe(false); // 15k+6k=21k > 20k
    expect(b.check(0, 6_000).reason).toContain('セッション');
  });

  it('record はセッション累計に積み上がる', () => {
    const b = new GenerationBudget({ sessionTokens: 100 });
    b.record(30);
    b.record(30);
    expect(b.sessionSpent()).toBe(60);
    expect(b.check(0, 40).ok).toBe(true); // 60+40=100 ちょうど
    expect(b.check(0, 41).ok).toBe(false); // 101 > 100
  });

  it('両方の上限を同時に見る(ジョブ内でも先に効いた方で止まる)', () => {
    const b = new GenerationBudget({ perJobTokens: 5_000, sessionTokens: 100_000 });
    expect(b.check(4_000, 2_000).ok).toBe(false); // job 6k > 5k
    expect(b.check(4_000, 2_000).reason).toContain('ジョブ');
  });
});
