import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractDescription } from './upload';

/**
 * M98: manifest.json を持たないツール(開発版で昇格したもの)は、公開時に
 * 「説明(description)が空」で止まっていた。説明の正本はプラグイン本体にあるので、
 * そこから読めることを固定する。
 */
describe('extractDescription', () => {
  it('単一のシングルクォート文字列を読む', () => {
    expect(extractDescription("export default { name: 'x', description: 'JSONを整形する', risk: 'safe' }")).toBe(
      'JSONを整形する',
    );
  });

  it('複数行に連結された説明(+ 連結)を1本に畳む', () => {
    const code = `export default {
  name: 'x',
  description:
    '2つのJSONを比較して差分を返す。' +
    'キーの追加・削除・変更を検出する',
  risk: 'safe',
}`;
    expect(extractDescription(code)).toBe('2つのJSONを比較して差分を返す。キーの追加・削除・変更を検出する');
  });

  it('ダブルクォート・バッククォートも読む', () => {
    expect(extractDescription('description: "説明D"')).toBe('説明D');
    expect(extractDescription('description: `説明B`')).toBe('説明B');
  });

  it('エスケープされたクォートを含む説明を壊さない', () => {
    expect(extractDescription("description: 'it\\'s ok'")).toBe("it's ok");
  });

  it('説明が無ければ空文字(嘘の説明を作らない)', () => {
    expect(extractDescription('export default { name: "x", risk: "safe" }')).toBe('');
  });

  it('実在の組み込みツールから説明を読める(回帰: 公開が止まらないこと)', () => {
    const dir = join(process.cwd(), 'src/main/tools/plugins');
    // テスト対象は「あれば見る」— 生成物なので環境により存在しないことがある
    for (const name of ['json_diff', 'slugify', 'svg_bar_chart', 'grep']) {
      const p = join(dir, `${name}.ts`);
      if (!existsSync(p)) continue;
      expect(extractDescription(readFileSync(p, 'utf8')).length, name).toBeGreaterThan(0);
    }
  });
});
