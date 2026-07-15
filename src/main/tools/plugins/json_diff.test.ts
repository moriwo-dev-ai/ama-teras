import { describe, expect, it } from 'vitest';
import type { ToolContext, ToolPlugin } from '../types';
import jsonDiff, { diffJson } from './json_diff';

function ctx(): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {} };
}

async function run(input: unknown): Promise<{ content: string; isError?: boolean }> {
  return jsonDiff.execute(input, ctx());
}

function parse(content: string): {
  added: { path: string; value: unknown }[];
  removed: { path: string; value: unknown }[];
  changed: { path: string; from: unknown; to: unknown }[];
  same: boolean;
  truncated?: boolean;
} {
  return JSON.parse(content) as ReturnType<typeof parse>;
}

describe('json_diff ツール', () => {
  it('完全一致なら same:true で差分ゼロ', async () => {
    const r = await run({ a: { x: 1, y: [1, 2], z: null }, b: { x: 1, y: [1, 2], z: null } });
    expect(r.isError).not.toBe(true);
    const d = parse(r.content);
    expect(d.same).toBe(true);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  it('追加・削除・変更をドット記法パスで列挙する', async () => {
    const a = { name: 'foo', size: 10, old: true };
    const b = { name: 'bar', size: 10, fresh: 1 };
    const d = parse((await run({ a, b })).content);
    expect(d.same).toBe(false);
    expect(d.added).toEqual([{ path: 'fresh', value: 1 }]);
    expect(d.removed).toEqual([{ path: 'old', value: true }]);
    expect(d.changed).toEqual([{ path: 'name', from: 'foo', to: 'bar' }]);
  });

  it('ネストと配列のパスは a.b[0].c 形式になる', async () => {
    const a = { a: { b: [{ c: 1 }, { c: 2 }] } };
    const b = { a: { b: [{ c: 1 }, { c: 99 }] } };
    const d = parse((await run({ a, b })).content);
    expect(d.changed).toEqual([{ path: 'a.b[1].c', from: 2, to: 99 }]);
  });

  it('配列の長さの差は added / removed になる', async () => {
    const d = parse((await run({ a: { xs: [1, 2, 3] }, b: { xs: [1] } })).content);
    expect(d.removed).toEqual([
      { path: 'xs[1]', value: 2 },
      { path: 'xs[2]', value: 3 },
    ]);
    const d2 = parse((await run({ a: { xs: [] }, b: { xs: ['new'] } })).content);
    expect(d2.added).toEqual([{ path: 'xs[0]', value: 'new' }]);
  });

  it('型変更(object→array・number→string)は changed 1件にまとまる', async () => {
    const d = parse((await run({ a: { v: { k: 1 } }, b: { v: [1] } })).content);
    expect(d.changed).toEqual([{ path: 'v', from: { k: 1 }, to: [1] }]);
    const d2 = parse((await run({ a: { n: 1 }, b: { n: '1' } })).content);
    expect(d2.changed).toEqual([{ path: 'n', from: 1, to: '1' }]);
  });

  it('null と undefined・null とオブジェクトを区別する', async () => {
    const d = parse((await run({ a: { v: null }, b: { v: { x: 1 } } })).content);
    expect(d.changed).toEqual([{ path: 'v', from: null, to: { x: 1 } }]);
  });

  it('ルートがプリミティブ同士でも比較できる((root) パス)', async () => {
    const d = parse((await run({ a: 1, b: 2 })).content);
    expect(d.changed).toEqual([{ path: '(root)', from: 1, to: 2 }]);
    const same = parse((await run({ a: 'x', b: 'x' })).content);
    expect(same.same).toBe(true);
  });

  it('ルート配列の差分は (root)[i] パスになる', async () => {
    const d = parse((await run({ a: [1, 2], b: [1, 3, 4] })).content);
    expect(d.changed).toEqual([{ path: '(root)[1]', from: 2, to: 3 }]);
    expect(d.added).toEqual([{ path: '(root)[2]', value: 4 }]);
  });

  it('識別子にできないキーは ["キー"] 表記でエスケープされる', async () => {
    const d = parse((await run({ a: { 'my key': { 'a.b': 1 } }, b: { 'my key': { 'a.b': 2 } } })).content);
    expect(d.changed).toEqual([{ path: '(root)["my key"]["a.b"]', from: 1, to: 2 }]);
  });

  it('a か b が欠けている・入力がオブジェクトでない場合はエラー', async () => {
    expect((await run({ a: 1 })).isError).toBe(true);
    expect((await run({ b: 1 })).isError).toBe(true);
    expect((await run('text')).isError).toBe(true);
    expect((await run(null)).isError).toBe(true);
  });

  it('a と b が明示的に null / undefined でも比較できる', async () => {
    const d = parse((await run({ a: null, b: null })).content);
    expect(d.same).toBe(true);
  });

  it('循環参照はエラーとして報告する(無限ループしない)', async () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    const b: Record<string, unknown> = {};
    b['self'] = b;
    const r = await run({ a, b });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('循環参照');
  });

  it('差分が上限を超えると truncated:true が付く', () => {
    const a: Record<string, number> = {};
    const b: Record<string, number> = {};
    for (let i = 0; i < 6000; i++) {
      a[`k${i}`] = i;
      b[`k${i}`] = i + 1;
    }
    const d = diffJson(a, b);
    expect(d.truncated).toBe(true);
    expect(d.changed.length).toBeLessThanOrEqual(5000);
    expect(d.same).toBe(false);
  });

  it('プラグイン規約: name・risk・tags・pathParams', () => {
    const asPlugin: ToolPlugin = jsonDiff;
    expect(asPlugin.name).toBe('json_diff');
    expect(asPlugin.risk).toBe('safe');
    expect(asPlugin.tags).toContain('テキスト処理');
    expect(asPlugin.pathParams).toBeUndefined();
  });
});
