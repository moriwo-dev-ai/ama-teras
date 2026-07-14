import { describe, expect, it } from 'vitest';
import { isJobActive } from './evolutionStatus';

/**
 * M79: 進化タブが「通知1」を出し続け、開いても中身が無い(唯一のジョブ #16 は done)。
 * バッジの終端判定に存在しない状態 'promoted' が書かれ、実在する 'done' と 'cancelled' が
 * 抜けていた。**終わったジョブは通知しない**。人間の手が要るものだけ通知する。
 */
describe('M79: 進化バッジは「手が要るジョブ」だけ数える', () => {
  it('終わったジョブは数えない(done が「進行中」に数えられていた実害)', () => {
    expect(isJobActive('done')).toBe(false);
    expect(isJobActive('cancelled')).toBe(false);
    expect(isJobActive('failed')).toBe(false);
    expect(isJobActive('rejected')).toBe(false);
    expect(isJobActive('rolled_back')).toBe(false);
  });

  it('動いている最中と、昇格承認待ち(人間待ち)は数える', () => {
    expect(isJobActive('queued')).toBe(true);
    expect(isJobActive('generating')).toBe(true);
    expect(isJobActive('verifying')).toBe(true);
    expect(isJobActive('promoting')).toBe(true);
    expect(isJobActive('awaiting_promotion')).toBe(true);
  });
});
