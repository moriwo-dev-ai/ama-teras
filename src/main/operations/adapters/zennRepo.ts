import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterRuntime } from '../protocol';

/**
 * M37: zenn-content リポジトリへの記事コミットアダプタ。
 *
 * 大原則(OPERATIONS_DESIGN.md)どおり、外部に出るのは承認後のみ:
 * このアダプタの executor は岩戸ゲートに封印され、承認ダイアログ
 * (何を・どこへ・全文=記事Markdown)を通ったときだけ到達できる。
 *
 * さらに二重の歯止めとして、書き出す記事は必ず published: false
 * (公開=true化はZenn/GitHub上で人間が別途行う判断)。
 */

/** git 実行関数(テストでモック差し替え)。stdout を返し、失敗は例外 */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export function defaultGitRunner(): GitRunner {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile('git', args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() !== '' ? stderr.trim() : err.message));
        else resolve(stdout);
      });
    });
}

/** Zennのslug規則: 半角英小文字・数字・ハイフン・アンダースコアで12〜50文字 */
export const ZENN_SLUG_RE = /^[0-9a-z\-_]{12,50}$/;

/**
 * タイトルからZennのslugを作る。日本語タイトルは英数が残らないので
 * スタンプ(YYYYMMDDHHmm等の数字列)だけの安定した名前に落とす。
 */
export function articleSlug(title: string, stamp: string, prefix = 'article'): string {
  const base = title
    .toLowerCase()
    .replace(/[^0-9a-z]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const safePrefix = prefix.toLowerCase().replace(/[^0-9a-z]+/g, '-').replace(/^-+|-+$/g, '') || 'article';
  const fallback = `${safePrefix}-${stamp}`.slice(0, 50);
  if (base === '') return fallback;
  const slug = `${base}-${stamp}`.slice(0, 50).replace(/-+$/, '');
  return ZENN_SLUG_RE.test(slug) ? slug : fallback;
}

export interface ArticleFrontmatter {
  title: string;
  emoji: string;
  type: 'tech' | 'idea';
  topics: string[];
}

/** frontmatter + 本文。published は必ず false(公開は人間の判断) */
export function buildArticleMarkdown(fm: ArticleFrontmatter, body: string): string {
  const topics = fm.topics.map((t) => `"${t.replace(/"/g, '')}"`).join(', ');
  return [
    '---',
    `title: "${fm.title.replace(/"/g, "'")}"`,
    `emoji: "${fm.emoji}"`,
    `type: "${fm.type}"`,
    `topics: [${topics}]`,
    'published: false',
    '---',
    '',
    body.trim(),
    '',
  ].join('\n');
}

export interface ZennRepoDeps {
  run: GitRunner;
  /** テスト用の書き出しフック(既定は fs) */
  writeArticle?: (path: string, content: string) => void;
}

/**
 * repoDir が未設定/非gitなら availability=false(UIで設定へ誘導)。
 * executor は commit-article のみ: articles/<slug>.md を書いて commit + push。
 */
export function createZennRepoAdapter(getRepoDir: () => string | null, deps: ZennRepoDeps): AdapterRuntime {
  const write =
    deps.writeArticle ??
    ((path: string, content: string): void => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content, 'utf8');
    });
  return {
    id: 'zenn-repo',
    capabilities: { read: false, search: false, draft: false, execute: ['commit-article'] },
    compliance:
      'Zenn記事はGitHub連携リポジトリ(zenn-content)へのコミットで反映される。published: false(非公開)でのみコミットし、公開は人間が行う',
    availability: () => {
      // 設定はいつでも変わりうるので、パスは登録時に固定せず毎回引く
      const dir = getRepoDir();
      return Promise.resolve(
        dir === null || dir.trim() === ''
          ? { available: false, detail: 'zenn-contentのパスが未設定(設定→接続→オーナーモード)' }
          : existsSync(join(dir, '.git'))
            ? { available: true }
            : { available: false, detail: `gitリポジトリではない: ${dir}` },
      );
    },
    executor: async (action, params) => {
      if (action !== 'commit-article') throw new Error(`未知のアクション: ${action}`);
      const repoDir = getRepoDir();
      if (repoDir === null || repoDir.trim() === '') throw new Error('zenn-contentのパスが未設定');
      const slug = String(params['slug'] ?? '');
      const markdown = String(params['markdown'] ?? '');
      if (!ZENN_SLUG_RE.test(slug)) throw new Error(`Zennのslug規則に合わない: ${slug}`);
      if (!/^---\r?\n/.test(markdown) || !/\npublished: false\r?\n/.test(markdown)) {
        // published: true の記事をこの経路で出すことは構造的に許さない
        throw new Error('記事に published: false のfrontmatterが無い(この経路では公開できない)');
      }
      const rel = `articles/${slug}.md`;
      write(join(repoDir, 'articles', `${slug}.md`), markdown);
      await deps.run(['add', rel], repoDir);
      await deps.run(['commit', '-m', `add: ${slug}(下書き・published: false)`], repoDir);
      await deps.run(['push'], repoDir);
      return `zenn-content に ${rel} を published: false でコミット・pushした(公開はZennの記事設定であなたが行う)`;
    },
  };
}
