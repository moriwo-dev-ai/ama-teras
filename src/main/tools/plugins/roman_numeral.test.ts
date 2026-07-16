import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../types';
import plugin, { toRoman } from './roman_numeral';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {}, ...overrides };
}

async function romanOf(input: unknown): Promise<string> {
  const r = await plugin.execute(input, ctx());
  expect(r.isError).toBeUndefined();
  const parsed = JSON.parse(r.content) as { roman: string };
  return parsed.roman;
}

describe('roman_numeral plugin', () => {
  it('name がファイル名と一致し risk が safe', () => {
    expect(plugin.name).toBe('roman_numeral');
    expect(plugin.risk).toBe('safe');
    expect(plugin.tags).toContain('テキスト処理');
  });

  it('基本例: {n: 2024} → "MMXXIV"', async () => {
    await expect(romanOf({ n: 2024 })).resolves.toBe('MMXXIV');
  });

  it('境界値: 1 → "I", 3999 → "MMMCMXCIX"', async () => {
    await expect(romanOf({ n: 1 })).resolves.toBe('I');
    await expect(romanOf({ n: 3999 })).resolves.toBe('MMMCMXCIX');
  });

  it('減算記法のペアが正しく変換される', async () => {
    await expect(romanOf({ n: 4 })).resolves.toBe('IV');
    await expect(romanOf({ n: 9 })).resolves.toBe('IX');
    await expect(romanOf({ n: 40 })).resolves.toBe('XL');
    await expect(romanOf({ n: 90 })).resolves.toBe('XC');
    await expect(romanOf({ n: 400 })).resolves.toBe('CD');
    await expect(romanOf({ n: 900 })).resolves.toBe('CM');
  });

  it('代表的な値が正しく変換される', async () => {
    await expect(romanOf({ n: 3 })).resolves.toBe('III');
    await expect(romanOf({ n: 14 })).resolves.toBe('XIV');
    await expect(romanOf({ n: 58 })).resolves.toBe('LVIII');
    await expect(romanOf({ n: 444 })).resolves.toBe('CDXLIV');
    await expect(romanOf({ n: 1000 })).resolves.toBe('M');
    await expect(romanOf({ n: 1994 })).resolves.toBe('MCMXCIV');
    await expect(romanOf({ n: 3888 })).resolves.toBe('MMMDCCCLXXXVIII');
  });

  it('toRoman 関数を直接呼んでも同じ結果になる', () => {
    expect(toRoman(2024)).toBe('MMXXIV');
    expect(toRoman(1)).toBe('I');
    expect(toRoman(3999)).toBe('MMMCMXCIX');
  });

  it('toRoman は範囲外の値で RangeError を投げる', () => {
    expect(() => toRoman(0)).toThrow(RangeError);
    expect(() => toRoman(4000)).toThrow(RangeError);
    expect(() => toRoman(1.5)).toThrow(RangeError);
  });

  it('範囲外の n はエラーを返す', async () => {
    for (const bad of [0, -1, 4000, 10000]) {
      const r = await plugin.execute({ n: bad }, ctx());
      expect(r.isError).toBe(true);
      expect(r.content).toContain('範囲');
    }
  });

  it('整数でない n はエラーを返す', async () => {
    for (const bad of [1.5, 3.14, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = await plugin.execute({ n: bad }, ctx());
      expect(r.isError).toBe(true);
    }
  });

  it('n が数値でない・欠落・非オブジェクト入力はエラーを返す', async () => {
    for (const bad of [{ n: '2024' }, {}, null, 'raw string', 42]) {
      const r = await plugin.execute(bad, ctx());
      expect(r.isError).toBe(true);
    }
  });
});
