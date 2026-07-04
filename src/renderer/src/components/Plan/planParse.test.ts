import { describe, expect, it } from 'vitest';
import { parsePlanProgress } from './planParse';

describe('parsePlanProgress(M12-2)', () => {
  it('チェックボックス行を進捗として数える', () => {
    const p = parsePlanProgress(
      ['# 計画', '- [ ] 手順1', '- [x] 手順2', '* [X] 手順3', '  - [ ] インデント', 'ただの行'].join('\n'),
    );
    expect(p.total).toBe(4);
    expect(p.done).toBe(2);
    expect(p.items[0]).toEqual({ text: '手順1', done: false });
    expect(p.items[2]).toEqual({ text: '手順3', done: true });
  });

  it('チェックボックスが無ければ items は空', () => {
    expect(parsePlanProgress('自由記述だけの計画')).toEqual({ items: [], done: 0, total: 0 });
  });
});
