import { describe, expect, it, vi } from 'vitest';
import { buildArticleOutlinePrompt } from './amenoUzume';
import { createZennRepoAdapter, buildArticleMarkdown, type GitRunner } from './adapters/zennRepo';

/**
 * M75: **公開リポジトリに未公開機能(月読)の内容が出た**(実害・M49の再発)。
 *
 * zenn-content は PUBLIC リポジトリで、published: false は Zenn 上で非公開にするだけ。
 * **GitHub上のファイルは誰でも読める**。にもかかわらず、記事本文の生成経路にだけ
 * 未公開ガードが1枚も無かった:
 * - 下書き生成(runUzumeDrafts)はM59で素材から未公開話題を抜いていた
 * - しかし記事本文(buildZennArticle)は PROGRESS.md を**生で**LLMに渡していた。
 *   PROGRESS.md は月読の開発記そのものなので、LLMは当然それを書いた
 * - コミット経路(commit-article)にも検査が無く、そのまま push された
 *
 * 3層で止める: ①素材から抜く ②プロンプトで禁じる ③コミット直前に構造的に弾く
 */

const TSUKUYOMI_BODY = '## はじめに\n未公開モード「月読(TUKU-yomi)」では、音声認識で約束を抽出します。';
const CLEAN_BODY = '## はじめに\n岩戸ゲートは、外部発信を承認なしには物理的に不可能にします。';

describe('M75: 記事本文プロンプトが未公開機能を禁じる', () => {
  it('「書いてはいけない話題」が入っており、素材にあっても書くなと明示する', () => {
    const prompt = buildArticleOutlinePrompt({
      title: 't',
      outline: 'o',
      progressExcerpt: 'p',
      project: { name: 'p', description: 'd' },
    });
    expect(prompt).toContain('書いてはいけない話題');
    expect(prompt).toContain('月読');
    expect(prompt).toContain('素材(PROGRESS.md)に書いてあっても');
  });
});

describe('M75: コミット経路の最後の砦(承認済みでも通さない)', () => {
  const adapter = (git: GitRunner) =>
    createZennRepoAdapter(() => 'C:/repo', { run: git, writeArticle: () => {}, readArticle: () => '' });

  it('未公開機能に触れる記事はコミットさせない(公開リポジトリのため)', async () => {
    const git = vi.fn<GitRunner>(async () => '');
    const md = buildArticleMarkdown({ title: 't', emoji: '⛩️', type: 'tech', topics: ['ai'] }, TSUKUYOMI_BODY);

    await expect(adapter(git).executor!('commit-article', { slug: 'my-article-001', markdown: md })).rejects.toThrow(
      /未公開機能.*公開リポジトリ/s,
    );
    expect(git).not.toHaveBeenCalled(); // add も commit も push もしない
  });

  it('クリーンな記事は従来どおりコミットできる', async () => {
    const git = vi.fn<GitRunner>(async () => '');
    const md = buildArticleMarkdown({ title: 't', emoji: '⛩️', type: 'tech', topics: ['ai'] }, CLEAN_BODY);

    const detail = await adapter(git).executor!('commit-article', { slug: 'my-article-001', markdown: md });

    expect(detail).toContain('published: false');
    expect(git.mock.calls.map((c) => c[0][0])).toEqual(['add', 'commit', 'push']);
  });
});
