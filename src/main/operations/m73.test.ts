import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, IwatoRequestPayload } from '../../shared/types';
import { OperationsManager } from './manager';
import { publishArticleMarkdown } from './adapters/zennRepo';

/**
 * M73: Zenn記事の公開をアプリから。
 *
 * これまで「記事化」ボタンは published: false でコミットするだけで、公開だけが人間の
 * 手作業として残っていた。結果、記事2本が丸一日以上、誰にも読めないまま放置された
 * (神議も毎回「公開作業の未実施がボトルネック」と正しく指摘し続けていた)。
 * GitHub Release は同じ危険度なのにスマホから公開できる(M60)ので、条件を揃える:
 * **岩戸ゲートで全文を読んで承認したときだけ公開できる**。
 */

const article = (slug: string, body: string, published = false): string =>
  ['---', `title: "${slug}"`, 'emoji: "🔥"', 'type: "tech"', 'topics: ["ai"]', `published: ${published}`, '---', '', body, ''].join('\n');

let dir: string;
let repoDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm73-'));
  repoDir = join(dir, 'zenn-content');
  mkdirSync(join(repoDir, 'articles'), { recursive: true });
  mkdirSync(join(repoDir, '.git'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeManager(onPrompt: (req: IwatoRequestPayload) => boolean = () => true) {
  const git: string[][] = [];
  const manager = new OperationsManager({
    userDataDir: dir,
    getConfig: () =>
      ({ operations: { enabled: true, repos: [], zennSlugs: [], zennRepoDir: repoDir } }) as unknown as AppConfig,
    audit: () => {},
    approvalPrompt: (req) => Promise.resolve(onPrompt(req)),
    bandProvider: () => 'キー未設定',
    gitRunner: async (args: string[]) => {
      git.push(args);
      return '';
    },
  });
  return { manager, git };
}

describe('M73: frontmatter の published だけを差し替える', () => {
  it('published: false → true(本文には触らない)', () => {
    const md = article('x', '# 本文\npublished: false と書いた行は本文にもある');
    const out = publishArticleMarkdown(md)!;
    expect(out).toContain('published: true');
    // 本文中の同じ文字列は書き換えない(frontmatter だけが対象)
    expect(out).toContain('published: false と書いた行は本文にもある');
  });

  it('すでに公開済みなら null(二重公開の余地を作らない)', () => {
    expect(publishArticleMarkdown(article('x', '本文', true))).toBeNull();
  });
});

describe('M73: Zenn記事の公開(岩戸ゲート必須)', () => {
  it('承認すると published: true になり push される。全文が承認ダイアログに出る', async () => {
    writeFileSync(join(repoDir, 'articles', 'my-article-001.md'), article('my-article-001', '公開される本文'), 'utf8');
    const prompts: IwatoRequestPayload[] = [];
    const { manager, git } = makeManager((req) => {
      prompts.push(req);
      return true;
    });
    await manager.status();

    const r = await manager.requestZennPublish('my-article-001');

    expect(r.ok).toBe(true);
    expect(prompts[0]!.preview).toContain('公開される本文'); // 人間が全文を読んでから承認する
    expect(prompts[0]!.preview).toContain('誰でも読めるようになります');
    expect(readFileSync(join(repoDir, 'articles', 'my-article-001.md'), 'utf8')).toContain('published: true');
    expect(git.some((c) => c[0] === 'push')).toBe(true);
  });

  it('却下すれば published: false のまま。pushもしない', async () => {
    writeFileSync(join(repoDir, 'articles', 'my-article-001.md'), article('my-article-001', '本文'), 'utf8');
    const { manager, git } = makeManager(() => false);
    await manager.status();

    const r = await manager.requestZennPublish('my-article-001');

    expect(r.ok).toBe(false);
    expect(readFileSync(join(repoDir, 'articles', 'my-article-001.md'), 'utf8')).toContain('published: false');
    expect(git.some((c) => c[0] === 'push')).toBe(false);
  });

  /** 未公開機能(月読)が世に出た事故が実際にあった(M49)。公開経路にも同じ歯止めを置く */
  it('未公開機能(月読)に触れる記事は、承認を求めることすらしない', async () => {
    writeFileSync(
      join(repoDir, 'articles', 'my-article-002.md'),
      article('my-article-002', '在席検知(カメラ)で「おかえり」と言わせる話'),
      'utf8',
    );
    const prompt = vi.fn(() => true);
    const { manager, git } = makeManager(prompt);
    await manager.status();

    const r = await manager.requestZennPublish('my-article-002');

    expect(r.ok).toBe(false);
    expect(r.detail).toContain('未公開機能');
    expect(prompt).not.toHaveBeenCalled(); // 承認ダイアログすら出さない
    expect(git).toHaveLength(0);
    expect(readFileSync(join(repoDir, 'articles', 'my-article-002.md'), 'utf8')).toContain('published: false');
  });

  it('公開できる記事の一覧を返す(未公開機能に触れるものは blocked)', async () => {
    writeFileSync(join(repoDir, 'articles', 'my-article-001.md'), article('my-article-001', '普通の本文'), 'utf8');
    writeFileSync(join(repoDir, 'articles', 'my-article-002.md'), article('my-article-002', '月読の話'), 'utf8');
    writeFileSync(join(repoDir, 'articles', 'my-article-003.md'), article('my-article-003', '公開済み', true), 'utf8');
    const { manager } = makeManager();
    await manager.status();

    const list = manager.zennPublishable();

    expect(list.map((a) => a.slug).sort()).toEqual(['my-article-001', 'my-article-002']); // 公開済みは出ない
    expect(list.find((a) => a.slug === 'my-article-001')!.blocked).toBeNull();
    expect(list.find((a) => a.slug === 'my-article-002')!.blocked).toContain('未公開機能');
  });
});
