import { describe, expect, it } from 'vitest';
import { detectOllama, OLLAMA_TAGS_URL, parseOllamaTags } from './ollama';

/** M114: ローカルOllama自動検出 — 検出の成否と /api/tags 解釈を固定する */

describe('M114: parseOllamaTags', () => {
  it('モデル名を順に取り出す', () => {
    expect(
      parseOllamaTags({ models: [{ name: 'qwen2.5-coder:14b' }, { name: 'llama3.3:70b' }] }),
    ).toEqual(['qwen2.5-coder:14b', 'llama3.3:70b']);
  });

  it('形が想定外なら空配列(throwしない)', () => {
    expect(parseOllamaTags(null)).toEqual([]);
    expect(parseOllamaTags({})).toEqual([]);
    expect(parseOllamaTags({ models: 'x' })).toEqual([]);
    expect(parseOllamaTags({ models: [{ name: 42 }, null, { name: ' ok ' }] })).toEqual(['ok']);
  });
});

describe('M114: detectOllama', () => {
  it('応答があれば available:true + モデル一覧', async () => {
    const r = await detectOllama(async (url) => {
      expect(url).toBe(OLLAMA_TAGS_URL);
      return { ok: true, json: async () => ({ models: [{ name: 'kimi-local:7b' }] }) };
    });
    expect(r).toEqual({ available: true, models: ['kimi-local:7b'] });
  });

  it('接続拒否(未インストール/停止)は静かに available:false', async () => {
    const r = await detectOllama(async () => {
      throw new Error('fetch failed: ECONNREFUSED');
    });
    expect(r).toEqual({ available: false, models: [] });
  });

  it('非200も available:false', async () => {
    const r = await detectOllama(async () => ({ ok: false, json: async () => ({}) }));
    expect(r).toEqual({ available: false, models: [] });
  });
});
