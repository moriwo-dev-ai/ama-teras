import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateCostUsd, UsageMeter } from './usage';

/** M23-2: 使用量メーター(日別×モデル別集計・概算コスト・永続化) */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amateras-usage-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('UsageMeter', () => {
  it('recordが日別×モデル別に集計され、todayと累計が分かれる', () => {
    let now = new Date('2026-07-06T10:00:00');
    const meter = new UsageMeter(join(dir, 'usage.json'), () => now);
    meter.record('anthropic', 'claude-fable-5', { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000 });
    meter.record('anthropic', 'claude-fable-5', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 });
    // 翌日
    now = new Date('2026-07-07T10:00:00');
    meter.record('anthropic', 'claude-fable-5', { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 });

    const s = meter.summary();
    expect(s.day).toBe('2026-07-07');
    const row = s.models.find((m) => m.model === 'anthropic/claude-fable-5')!;
    expect(row.today).toMatchObject({ input: 10, output: 5, calls: 1 });
    expect(row.total).toMatchObject({ input: 1110, output: 555, cacheRead: 2000, calls: 3 });
  });

  it('概算コスト: Fable5は$10/$50・cache読み取りは0.1×入力単価。未知モデルはnull', () => {
    // 1Mトークンずつ: 10 + 50 + 1(cache 1M × $1) = $61
    expect(
      estimateCostUsd('anthropic/claude-fable-5', { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }),
    ).toBeCloseTo(61);
    // gpt-5.1 は旧世代のため単価表に無い(M25-4時点で意図的に非対応=null)
    expect(estimateCostUsd('openai/gpt-5.1', { input: 1000, output: 1000, cacheRead: 0 })).toBeNull();
  });

  it('M25-4: OpenAI現行モデルの概算コスト(gpt-5.4系はmini/nanoをgpt-5.4より先に照合)', () => {
    // 1Mトークンずつ: 5 + 30 + 0.5(cache 1M × $5 × 0.1) = $35.5
    expect(
      estimateCostUsd('openai/gpt-5.5', { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }),
    ).toBeCloseTo(35.5);
    // gpt-5.4-mini は 'gpt-5.4' で始まるが、より具体的な mini 単価($0.75/$4.5)が優先される
    expect(
      estimateCostUsd('openai/gpt-5.4-mini', { input: 1_000_000, output: 1_000_000, cacheRead: 0 }),
    ).toBeCloseTo(0.75 + 4.5);
    expect(
      estimateCostUsd('openai/gpt-5.4-nano', { input: 1_000_000, output: 1_000_000, cacheRead: 0 }),
    ).toBeCloseTo(0.2 + 1.25);
    expect(
      estimateCostUsd('openai/gpt-5.4', { input: 1_000_000, output: 1_000_000, cacheRead: 0 }),
    ).toBeCloseTo(2.5 + 15);
    expect(
      estimateCostUsd('openai/gpt-5.3-codex', { input: 1_000_000, output: 1_000_000, cacheRead: 0 }),
    ).toBeCloseTo(1.75 + 14);
  });

  it('M26-4: band付きrecordが帯別に集計され、帯別コストも概算される', () => {
    let now = new Date('2026-07-06T10:00:00');
    const meter = new UsageMeter(join(dir, 'usage.json'), () => now);
    meter.record('anthropic', 'claude-fable-5', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }, 'planner');
    meter.record('anthropic', 'claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }, 'explorer');
    meter.record('anthropic', 'claude-haiku-4-5', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }); // band無し→other
    now = new Date('2026-07-07T10:00:00');
    meter.record('anthropic', 'claude-fable-5', { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0 }, 'planner');

    const s = meter.summary();
    const planner = s.bands.find((b) => b.band === 'planner')!;
    expect(planner.total).toMatchObject({ input: 1_000_500, output: 100, calls: 2 });
    expect(planner.today).toMatchObject({ input: 500, output: 100, calls: 1 });
    expect(planner.total.costUsd).toBeCloseTo(10 + (500 * 10 + 100 * 50) / 1_000_000);
    const explorer = s.bands.find((b) => b.band === 'explorer')!;
    expect(explorer.total.costUsd).toBeCloseTo(1); // Haiku $1/1M input
    expect(s.bands.some((b) => b.band === 'other')).toBe(true);
  });

  it('M26-4: 旧形式ファイル(bandDays無し)でも壊れず、bandsは空になる', () => {
    const file = join(dir, 'usage.json');
    const now = new Date('2026-07-06T10:00:00');
    const meter = new UsageMeter(file, () => now);
    meter.record('anthropic', 'claude-fable-5', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 });
    meter.flush();
    // bandDays を意図的に消した旧形式を再現
    const { readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { days: unknown };
    writeFileSync(file, JSON.stringify({ days: raw.days }), 'utf8');
    const reloaded = new UsageMeter(file, () => now);
    expect(reloaded.summary().bands).toEqual([]);
    expect(reloaded.summary().models).toHaveLength(1);
  });

  it('flushで永続化され、新しいメーターに引き継がれる', () => {
    const file = join(dir, 'usage.json');
    const now = new Date('2026-07-06T10:00:00');
    const meter = new UsageMeter(file, () => now);
    meter.record('openai', 'gpt-5.1', { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0 });
    meter.flush();

    const reloaded = new UsageMeter(file, () => now);
    const row = reloaded.summary().models.find((m) => m.model === 'openai/gpt-5.1')!;
    expect(row.total).toMatchObject({ input: 7, output: 3, calls: 1 });
    // 未知モデルはコスト非表示だが合計には既知分のみ計上(この場合null)
    expect(reloaded.summary().totalCostUsd).toBeNull();
  });
});

describe('M30-1: GPT-5.6 世代の概算コスト', () => {
  it('Sol/Terra/Luna の3層単価と、terra/luna が汎用 gpt-5.6 に埋もれない照合順', () => {
    const oneM = { input: 1_000_000, output: 1_000_000, cacheRead: 0 };
    expect(estimateCostUsd('openai/gpt-5.6-sol', oneM)).toBeCloseTo(5 + 30);
    expect(estimateCostUsd('openai/gpt-5.6-terra', oneM)).toBeCloseTo(2.5 + 15);
    expect(estimateCostUsd('openai/gpt-5.6-luna', oneM)).toBeCloseTo(1 + 6);
    // 素の 'gpt-5.6'(エイリアス=Sol解決)は Sol と同額
    expect(estimateCostUsd('openai/gpt-5.6', oneM)).toBeCloseTo(35);
    // キャッシュ読取は input の 0.1 倍
    expect(
      estimateCostUsd('openai/gpt-5.6-sol', { input: 0, output: 0, cacheRead: 1_000_000 }),
    ).toBeCloseTo(0.5);
  });
});
