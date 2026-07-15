import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GenerationMetrics, summarize, type GenerationRecord } from './metrics';

/**
 * M92-Phase0: 生成の計測。どのレバーが効いたかを測る物差し。記録と集計だけ(ライブ実行はしない)。
 */

const rec = (over: Partial<GenerationRecord> = {}): GenerationRecord => ({
  jobId: 1,
  scope: 'tool',
  outcome: 'promoted',
  attempts: 1,
  durationMs: 1000,
  at: '2026-07-16T00:00:00.000Z',
  ...over,
});

describe('summarize', () => {
  it('成功率・平均試行・失敗内訳を出す', () => {
    const s = summarize([
      rec({ jobId: 1, outcome: 'promoted', attempts: 1 }),
      rec({ jobId: 2, outcome: 'promoted', attempts: 3 }),
      rec({ jobId: 3, outcome: 'failed', attempts: 4, failureKinds: ['typecheck', 'test'] }),
      rec({ jobId: 4, outcome: 'failed', attempts: 4, failureKinds: ['typecheck'] }),
    ]);
    expect(s.total).toBe(4);
    expect(s.promoted).toBe(2);
    expect(s.successRate).toBe(0.5);
    expect(s.avgAttemptsOnSuccess).toBe(2); // (1+3)/2
    expect(s.byOutcome).toEqual({ promoted: 2, failed: 2 });
    expect(s.failureKinds).toEqual({ typecheck: 2, test: 1 });
  });

  it('空なら 0 で割らない', () => {
    const s = summarize([]);
    expect(s.total).toBe(0);
    expect(s.successRate).toBe(0);
    expect(s.avgAttemptsOnSuccess).toBe(0);
  });
});

describe('GenerationMetrics(永続化)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'amateras-metrics-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('追記して読み戻せる(サブディレクトリも作る)', () => {
    const m = new GenerationMetrics(join(dir, 'sub', 'metrics.jsonl'));
    m.record(rec({ jobId: 1, outcome: 'promoted' }));
    m.record(rec({ jobId: 2, outcome: 'failed', failureKinds: ['test'] }));
    expect(m.read()).toHaveLength(2);
    expect(m.summary().successRate).toBe(0.5);
  });

  it('ファイルが無ければ空(計測は本流を止めない)', () => {
    expect(new GenerationMetrics(join(dir, 'none.jsonl')).read()).toEqual([]);
  });
});
