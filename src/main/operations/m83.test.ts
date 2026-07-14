import { describe, expect, it } from 'vitest';
import { ZENN_DEPLOY_LIMIT, zennWindowFromStamps } from './manager';

/**
 * M83: 再デプロイを押しても403のまま。Zennは**直近24時間に5本以上の投稿(デプロイ)を止める**。
 * 再デプロイもデプロイなので、詰まっているときに押すほど窓に積み上がり、**押すほど遅くなる**。
 * 実機では24時間内に10本(上限の倍)積んでいた。押す前に数えて、押させない。
 */

const hoursAgo = (h: number, now = 1_800_000_000): number => now - h * 3600;

describe('M83: Zennの24時間ウィンドウを、押す前に数える', () => {
  it('上限未満なら「いつ空くか」は不要(いま押せる)', () => {
    const w = zennWindowFromStamps([hoursAgo(1), hoursAgo(2), hoursAgo(3)]);
    expect(w.count).toBe(3);
    expect(w.freeAtMs).toBeNull();
  });

  it('枠が空くのは「上限番目に古い投稿」の24時間後(一番古いのが出た時ではない)', () => {
    const stamps = [hoursAgo(23), hoursAgo(22), hoursAgo(21), hoursAgo(20), hoursAgo(19), hoursAgo(1)];
    const w = zennWindowFromStamps(stamps);

    expect(w.count).toBe(6);
    expect(w.count).toBeGreaterThanOrEqual(ZENN_DEPLOY_LIMIT);
    // 6本あるので、5番目に古い(=22時間前)が窓を出れば残り4本 → 空く
    expect(w.freeAtMs).toBe((hoursAgo(22) + 24 * 3600) * 1000);
  });

  it('実機の再現: 24時間に10本(上限の倍)', () => {
    const w = zennWindowFromStamps(Array.from({ length: 10 }, (_, i) => hoursAgo(i + 1)));
    expect(w.count).toBe(10);
    expect(w.freeAtMs).not.toBeNull(); // 押させない
  });
});
