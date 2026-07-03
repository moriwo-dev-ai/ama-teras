import { describe, expect, it } from 'vitest';
import { lineDiff } from './diff';

describe('lineDiff', () => {
  it('同一テキストは全行same', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'same', text: 'b' },
    ]);
  });

  it('追加と削除を検出する', () => {
    const d = lineDiff('a\nb\nc', 'a\nx\nc');
    expect(d).toContainEqual({ kind: 'del', text: 'b' });
    expect(d).toContainEqual({ kind: 'add', text: 'x' });
    expect(d.filter((l) => l.kind === 'same').map((l) => l.text)).toEqual(['a', 'c']);
  });

  it('空→内容は全行add', () => {
    expect(lineDiff('', 'a\nb')).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'b' },
    ]);
  });

  it('内容→空は全行del', () => {
    expect(lineDiff('a', '')).toEqual([{ kind: 'del', text: 'a' }]);
  });
});
