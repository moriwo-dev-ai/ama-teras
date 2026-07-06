import { describe, expect, it } from 'vitest';
import { groupSessionsByProject } from './sessionGroups';
import type { SessionMeta } from './types';

function meta(id: string, workspace: string, updatedAt: string): SessionMeta {
  return { id, title: id, workspace, createdAt: updatedAt, updatedAt, messageCount: 1 };
}

describe('groupSessionsByProject (M17-3)', () => {
  const A1 = meta('a1', 'C:\\proj\\A', '2026-07-06T10:00:00Z');
  const A2 = meta('a2', 'C:\\proj\\A', '2026-07-05T10:00:00Z');
  const B1 = meta('b1', 'C:\\proj\\B', '2026-07-06T12:00:00Z');
  const C1 = meta('c1', 'C:\\proj\\C', '2026-07-04T10:00:00Z');

  it('プロジェクトは配下セッションの最新 updatedAt 降順に並ぶ', () => {
    const groups = groupSessionsByProject([A1, A2, B1, C1]);
    expect(groups.map(([ws]) => ws)).toEqual(['C:\\proj\\B', 'C:\\proj\\A', 'C:\\proj\\C']);
    // グループ内は入力順を保つ
    expect(groups[1]![1].map((s) => s.id)).toEqual(['a1', 'a2']);
  });

  it('選択(閲覧)では並びが変わらない — ソートは updatedAt のみに依存する', () => {
    // 「現在のプロジェクト」という概念を入力に取らないことが仕様。
    // 同じ入力なら何度呼んでも同じ順序になる(選択状態に依存しない)
    const input = [A1, A2, B1, C1];
    const first = groupSessionsByProject(input).map(([ws]) => ws);
    const second = groupSessionsByProject(input).map(([ws]) => ws);
    expect(second).toEqual(first);
  });

  it('セッションが更新されたらそのプロジェクトが先頭へ来る', () => {
    const before = groupSessionsByProject([A1, B1]).map(([ws]) => ws);
    expect(before).toEqual(['C:\\proj\\B', 'C:\\proj\\A']);
    const updatedA = { ...A2, updatedAt: '2026-07-06T13:00:00Z' };
    const after = groupSessionsByProject([A1, updatedA, B1]).map(([ws]) => ws);
    expect(after).toEqual(['C:\\proj\\A', 'C:\\proj\\B']);
  });

  it('同時刻のプロジェクトは出現順を保つ(安定ソート)', () => {
    const X = meta('x', 'C:\\proj\\X', '2026-07-06T10:00:00Z');
    const Y = meta('y', 'C:\\proj\\Y', '2026-07-06T10:00:00Z');
    expect(groupSessionsByProject([X, Y]).map(([ws]) => ws)).toEqual(['C:\\proj\\X', 'C:\\proj\\Y']);
    expect(groupSessionsByProject([Y, X]).map(([ws]) => ws)).toEqual(['C:\\proj\\Y', 'C:\\proj\\X']);
  });

  it('workspace 空は「(既定)」へまとまり、不正な日時は最古扱い', () => {
    const empty = meta('e', '', '2026-07-06T10:00:00Z');
    const broken = meta('br', 'C:\\proj\\Z', 'not-a-date');
    const groups = groupSessionsByProject([broken, empty]);
    expect(groups.map(([ws]) => ws)).toEqual(['(既定)', 'C:\\proj\\Z']);
  });
});
