import { describe, expect, it } from 'vitest';
import { completedItems, newlyCompleted } from './planDiff';

describe('planDiff (M19)', () => {
  it('- [x] 項目を抽出する(- [ ] や本文行は無視)', () => {
    const md = `# 計画\n- [ ] 未了A\n- [x] 完了B\n  - [X] ネスト完了C\n* [x] アスタリスク完了D\nただの行\n- [x]`;
    expect(completedItems(md)).toEqual(['完了B', 'ネスト完了C', 'アスタリスク完了D']);
  });

  it('newlyCompleted は新規完了だけを返す', () => {
    const before = `- [x] A\n- [ ] B\n- [ ] C`;
    const after = `- [x] A\n- [x] B\n- [ ] C`;
    expect(newlyCompleted(before, after)).toEqual(['B']);
  });

  it('変化なし・逆行(x→空)では空配列', () => {
    const before = `- [x] A\n- [x] B`;
    expect(newlyCompleted(before, `- [x] A\n- [x] B`)).toEqual([]);
    expect(newlyCompleted(before, `- [x] A\n- [ ] B`)).toEqual([]);
  });

  it('計画新規作成時(before空)は既完了項目が全部「新規完了」になる', () => {
    expect(newlyCompleted('', `- [x] A\n- [ ] B`)).toEqual(['A']);
  });
});
