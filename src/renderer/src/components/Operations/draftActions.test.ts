import { describe, expect, it } from 'vitest';
import type { OperationsDraft } from '../../../../shared/types';
import { draftActionsFor } from './draftActions';

const KINDS: OperationsDraft['kind'][] = [
  'x-post',
  'release-note',
  'article-outline',
  'article-body',
  'reply',
  'weekly-report',
];

describe('M37: 下書きの種類 → 行き先(コードで固定)', () => {
  it('X投稿だけがXの投稿画面へ。長文の種類にXボタンは出ない(文字数制限)', () => {
    expect(draftActionsFor('x-post')).toContain('x-intent');
    for (const kind of ['release-note', 'article-outline', 'article-body', 'weekly-report'] as const) {
      expect(draftActionsFor(kind)).not.toContain('x-intent');
    }
  });

  it('リリースノート→GitHub Release、記事アウトライン→Zenn記事化。取り違えは起きない', () => {
    expect(draftActionsFor('release-note')).toEqual(['github-release']);
    expect(draftActionsFor('article-outline')).toEqual(['zenn-article']);
    expect(draftActionsFor('x-post')).not.toContain('github-release');
    expect(draftActionsFor('x-post')).not.toContain('zenn-article');
  });

  it('週報・返信・記事本文は外部への行き先を持たない(コピーのみ)', () => {
    expect(draftActionsFor('weekly-report')).toEqual([]);
    expect(draftActionsFor('reply')).toEqual([]);
    expect(draftActionsFor('article-body')).toEqual([]);
  });

  it('全ての種類が表に載っている(新種類の入れ忘れ検出)', () => {
    for (const kind of KINDS) expect(Array.isArray(draftActionsFor(kind))).toBe(true);
  });
});
