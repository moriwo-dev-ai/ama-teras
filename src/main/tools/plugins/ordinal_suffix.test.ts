import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../types';
import plugin, { ordinalSuffixOf, toOrdinal } from './ordinal_suffix';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {}, ...overrides };
}

async function ordinalOf(input: unknown): Promise<string> {
  const r = await plugin.execute(input, ctx());
  expect(r.isError).toBeUndefined();
  const parsed = JSON.parse(r.content) as { ordinal: string };
  return parsed.ordinal;
}

describe('ordinal_suffix plugin', () => {
  it('name がファイル名と一致し risk が safe', () => {
    expect(plugin.name).toBe('ordinal_suffix');
    expect(plugin.risk).toBe('safe');
    expect(plugin.tags).toContain('テキスト処理');
  });

  it('下1桁の基本規則: 1st / 2nd / 3rd / 4th', () => {
    expect(toOrdinal(1)).toBe('1st');
    expect(toOrdinal(2)).toBe('2nd');
    expect(toOrdinal(3)).toBe('3rd');
    expect(toOrdinal(4)).toBe('4th');
  });

  it('11〜13 は下1桁に関係なく th(この例外が序数の罠)', () => {
    expect(toOrdinal(11)).toBe('11th');
    expect(toOrdinal(12)).toBe('12th');
    expect(toOrdinal(13)).toBe('13th');
  });

  it('111〜113 も th。21/22/23 は例外ではない', () => {
    expect(toOrdinal(111)).toBe('111th');
    expect(toOrdinal(112)).toBe('112th');
    expect(toOrdinal(113)).toBe('113th');
    expect(toOrdinal(21)).toBe('21st');
    expect(toOrdinal(22)).toBe('22nd');
    expect(toOrdinal(23)).toBe('23rd');
  });

  it('0 と 100 は th', () => {
    expect(toOrdinal(0)).toBe('0th');
    expect(toOrdinal(100)).toBe('100th');
    expect(toOrdinal(101)).toBe('101st');
  });

  it('負数は符号を保ち、絶対値で判定する', () => {
    expect(toOrdinal(-1)).toBe('-1st');
    expect(toOrdinal(-11)).toBe('-11th');
    expect(toOrdinal(-22)).toBe('-22nd');
  });

  it('suffix だけも取れる', () => {
    expect(ordinalSuffixOf(3)).toBe('rd');
    expect(ordinalSuffixOf(13)).toBe('th');
  });

  it('execute が {ordinal, suffix} を返す', async () => {
    const r = await plugin.execute({ value: 42 }, ctx());
    expect(JSON.parse(r.content)).toEqual({ ordinal: '42nd', suffix: 'nd' });
  });

  it('基本例が execute 経由でも通る', async () => {
    await expect(ordinalOf({ value: 1 })).resolves.toBe('1st');
    await expect(ordinalOf({ value: 113 })).resolves.toBe('113th');
  });

  it('整数以外・非数値・非有限はエラー(嘘の序数を返さない)', async () => {
    for (const bad of [{ value: 1.5 }, { value: '1' }, { value: NaN }, { value: Infinity }, {}, null]) {
      const r = await plugin.execute(bad, ctx());
      expect(r.isError, JSON.stringify(bad)).toBe(true);
    }
  });

  it('安全な整数の範囲を超える値はエラー', async () => {
    const r = await plugin.execute({ value: Number.MAX_SAFE_INTEGER * 2 }, ctx());
    expect(r.isError).toBe(true);
  });
});
