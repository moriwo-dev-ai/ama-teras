import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../types';
import plugin, { formatDuration } from './duration_format';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {}, ...overrides };
}

async function run(input: unknown): Promise<{ text: string }> {
  const r = await plugin.execute(input, ctx());
  expect(r.isError).toBeUndefined();
  return JSON.parse(r.content) as { text: string };
}

describe('duration_format plugin', () => {
  it('name がファイル名と一致し risk が safe', () => {
    expect(plugin.name).toBe('duration_format');
    expect(plugin.risk).toBe('safe');
    expect(plugin.tags?.length).toBeGreaterThan(0);
  });

  it('時・分・秒を "1h 2m 3s" 形式で返す', async () => {
    const parsed = await run({ seconds: 3723 });
    expect(parsed.text).toBe('1h 2m 3s');
  });

  it('0 は "0s" を返す', async () => {
    const parsed = await run({ seconds: 0 });
    expect(parsed.text).toBe('0s');
  });

  it('秒のみ・分秒のみは上位単位を省く', async () => {
    expect((await run({ seconds: 45 })).text).toBe('45s');
    expect((await run({ seconds: 65 })).text).toBe('1m 5s');
  });

  it('上位単位があれば下位単位は 0 でも表示する', async () => {
    expect((await run({ seconds: 3600 })).text).toBe('1h 0m 0s');
    expect((await run({ seconds: 3601 })).text).toBe('1h 0m 1s');
    expect((await run({ seconds: 120 })).text).toBe('2m 0s');
  });

  it('端数(小数秒)をミリ秒精度で扱い末尾の0を省く', async () => {
    expect((await run({ seconds: 1.5 })).text).toBe('1.5s');
    expect((await run({ seconds: 3661.25 })).text).toBe('1h 1m 1.25s');
    expect((await run({ seconds: 0.001 })).text).toBe('0.001s');
    // ミリ秒未満は四捨五入される
    expect((await run({ seconds: 0.0004 })).text).toBe('0s');
    // 浮動小数点誤差(0.1+0.2=0.30000000000000004)も丸めて扱う
    expect((await run({ seconds: 0.1 + 0.2 })).text).toBe('0.3s');
  });

  it('端数の繰り上がりで 60s にならない(59.9995 → 1m 0s)', async () => {
    expect((await run({ seconds: 59.9995 })).text).toBe('1m 0s');
  });

  it('負数は先頭に "-" を付ける', async () => {
    expect((await run({ seconds: -65 })).text).toBe('-1m 5s');
    expect((await run({ seconds: -0.5 })).text).toBe('-0.5s');
  });

  it('24時間を超えても時間単位のまま表示する', async () => {
    expect((await run({ seconds: 90_000 })).text).toBe('25h 0m 0s');
  });

  it('不正な入力は isError を返す', async () => {
    const cases: unknown[] = [
      null,
      'x',
      {},
      { seconds: 'abc' },
      { seconds: Number.NaN },
      { seconds: Number.POSITIVE_INFINITY },
    ];
    for (const input of cases) {
      const r = await plugin.execute(input, ctx());
      expect(r.isError).toBe(true);
    }
  });

  it('formatDuration を直接呼んでも同じ結果になる', () => {
    expect(formatDuration(3723)).toBe('1h 2m 3s');
    expect(formatDuration(0)).toBe('0s');
  });
});
