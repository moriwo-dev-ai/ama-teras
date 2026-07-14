import { describe, expect, it } from 'vitest';
import { notYetCommitted } from './manager';
import { formatPublishState, type PublishState } from './kamuhakari';
import type { OperationsDraft } from '../../shared/types';

/**
 * M79: 神議が「公開待ちのZenn記事を公開する。公開ボタンを押して世に出してください」という
 * **押しても何も起きないカード**を出し続けた。その記事はすでに published: true で push 済みで、
 * 止めていたのは Zenn の投稿数上限(同期未完)。公開待ち(まだ出していない)と
 * 同期待ち(出したのに届いていない)を混ぜていたのが原因。
 */

const draft = (title: string): OperationsDraft =>
  ({ id: title, media: 'zenn', kind: 'article-outline', title, body: '', status: 'staged' }) as OperationsDraft;

const state = (articles: PublishState['zennArticles']): PublishState => ({
  releases: [],
  zennArticles: articles,
  unavailable: [],
});

describe('M79: 公開待ちと同期待ちを分ける', () => {
  it('push済み(published: true)の記事は「公開待ち」から外す — 公開操作はもう済んでいる', () => {
    const staged = [draft('幽霊スケジューラの話'), draft('まだ書いただけの記事')];
    const out = notYetCommitted(staged, state([{ slug: 'ghost-001', published: true, live: false, title: '幽霊スケジューラの話' }]));

    expect(out.map((d) => d.title)).toEqual(['まだ書いただけの記事']);
  });

  it('slugで参照している下書き(本文側)も外す', () => {
    const out = notYetCommitted([draft('Zenn記事: 何か(ghost-001)')], state([{ slug: 'ghost-001', published: true, title: '別のタイトル' }]));
    expect(out).toEqual([]);
  });

  it('published: false の記事は本当に公開待ちなので残す', () => {
    const out = notYetCommitted([draft('下書きの記事')], state([{ slug: 'x', published: false, title: '下書きの記事' }]));
    expect(out.map((d) => d.title)).toEqual(['下書きの記事']);
  });

  it('同期待ちの記事は、一次情報の側で「公開提案は無意味・再デプロイが要る」と伝える', () => {
    const text = formatPublishState(state([{ slug: 'ghost-001', published: true, live: false, title: 'x' }]));
    expect(text).toContain('「公開する」提案は無意味');
    expect(text).toContain('再デプロイ');
  });
});
