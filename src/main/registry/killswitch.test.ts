import { describe, expect, it } from 'vitest';
import { fetchRevocationList } from './killswitch';

function fakeFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

describe('M27-4: fetchRevocationList(キルスイッチ)', () => {
  it('{revoked:[...]} 形式と配列形式の両方をパースし、文字列/オブジェクト混在も受ける', async () => {
    const wrapped = await fetchRevocationList('https://x/r.json', fakeFetch({
      revoked: ['tool_a', { name: 'tool_b', reason: '脆弱性CVE-XXXX' }],
    }));
    expect(wrapped).toEqual([
      { name: 'tool_a', reason: '失効リストに登録されている' },
      { name: 'tool_b', reason: '脆弱性CVE-XXXX' },
    ]);

    const bare = await fetchRevocationList('https://x/r.json', fakeFetch([{ name: 'tool_c' }]));
    expect(bare?.[0]?.name).toBe('tool_c');
  });

  it('不達・HTTPエラー・不正JSONは null(静かにスキップ)', async () => {
    const err = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await fetchRevocationList('https://x/r.json', err)).toBeNull();
    expect(await fetchRevocationList('https://x/r.json', fakeFetch({}, false))).toBeNull();
    // 形式が想定外でも例外にせず空リスト(=何も無効化しない)
    expect(await fetchRevocationList('https://x/r.json', fakeFetch({ foo: 1 }))).toEqual([]);
    expect(await fetchRevocationList('https://x/r.json', fakeFetch(['', 42]))).toEqual([]);
  });
});
