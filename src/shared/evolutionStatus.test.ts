import { describe, expect, it } from 'vitest';
import { isJobActive, isPublishableJob } from './evolutionStatus';

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

describe('isPublishableJob(公開ボタンを出してよいか)', () => {
  const base = { status: 'done' as const, scope: 'tool' as const, toolName: 'slugify' };

  it('mainに入った完了ツールは公開できる', () => {
    expect(isPublishableJob(base)).toBe(true);
  });

  it('夜間自動昇格(autoBranch)は公開できない — mainにソースが無く必ず失敗する', () => {
    // 実機の ordinal_suffix / to_base64 がこれで「ソースが見つからない」になっていた
    expect(isPublishableJob({ ...base, autoBranch: 'evolve/nightly' })).toBe(false);
  });

  it('未完了・renderer/core・ツール名なしは公開できない', () => {
    expect(isPublishableJob({ ...base, status: 'generating' })).toBe(false);
    expect(isPublishableJob({ ...base, status: 'failed' })).toBe(false);
    expect(isPublishableJob({ ...base, scope: 'renderer' })).toBe(false);
    expect(isPublishableJob({ ...base, scope: 'core' })).toBe(false);
    expect(isPublishableJob({ status: 'done', scope: 'tool' })).toBe(false);
  });

  it('scope未設定(旧ジョブ=tool扱い)は公開できる', () => {
    expect(isPublishableJob({ status: 'done', toolName: 'old' })).toBe(true);
  });
});
