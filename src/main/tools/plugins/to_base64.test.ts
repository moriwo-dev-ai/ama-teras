import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../types';
import plugin, { decodeBase64, encodeBase64 } from './to_base64';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {}, ...overrides };
}

async function resultOf(input: unknown): Promise<string> {
  const r = await plugin.execute(input, ctx());
  expect(r.isError, r.content).toBeUndefined();
  const parsed = JSON.parse(r.content) as { result: string };
  return parsed.result;
}

describe('to_base64 plugin', () => {
  it('name がファイル名と一致し risk が safe', () => {
    expect(plugin.name).toBe('to_base64');
    expect(plugin.risk).toBe('safe');
    expect(plugin.tags).toContain('テキスト処理');
  });

  it('ASCII を符号化する', async () => {
    await expect(resultOf({ text: 'hello' })).resolves.toBe('aGVsbG8=');
  });

  it('日本語(マルチバイト)をUTF-8として符号化する', async () => {
    await expect(resultOf({ text: 'こんにちは' })).resolves.toBe('44GT44KT44Gr44Gh44Gv');
  });

  it('空文字は空文字', async () => {
    await expect(resultOf({ text: '' })).resolves.toBe('');
  });

  it('URL安全形式は + / を - _ にし、パディングを落とす', () => {
    // 標準形式に + と / が両方出る入力を選ぶ
    const raw = String.fromCharCode(0xfb, 0xff, 0xbf);
    const std = encodeBase64(raw);
    const safe = encodeBase64(raw, true);
    expect(std).toMatch(/[+/]/);
    expect(safe).not.toMatch(/[+/=]/);
    expect(safe).toBe(std.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''));
  });

  it('復号すると元に戻る(標準・URL安全のどちらでも)', async () => {
    for (const text of ['hello', 'こんにちは', '', 'a/b+c?d=e', '🎌 絵文字も']) {
      expect(decodeBase64(encodeBase64(text))).toEqual({ text });
      expect(decodeBase64(encodeBase64(text, true))).toEqual({ text });
    }
  });

  it('decode=true で復号できる', async () => {
    await expect(resultOf({ text: '44GT44KT44Gr44Gh44Gv', decode: true })).resolves.toBe('こんにちは');
  });

  it('不正なBase64は黙って壊れた文字列を返さずエラーにする', async () => {
    // Buffer.from は不正入力を捨てて「それらしい」結果を返すので、そこを信用しない
    for (const bad of ['!!!!', 'aGVsbG8=extra', 'a']) {
      const r = await plugin.execute({ text: bad, decode: true }, ctx());
      expect(r.isError, bad).toBe(true);
    }
  });

  it('引数の型違いはエラー', async () => {
    for (const bad of [{ text: 1 }, { text: 'x', decode: 'yes' }, { text: 'x', urlSafe: 1 }, {}, null]) {
      const r = await plugin.execute(bad, ctx());
      expect(r.isError, JSON.stringify(bad)).toBe(true);
    }
  });

  it('長すぎる入力はエラー', async () => {
    const r = await plugin.execute({ text: 'a'.repeat(1_000_001) }, ctx());
    expect(r.isError).toBe(true);
  });
});
