import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mentionsUnreleased } from '../../../shared/operations';
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
  /** M73: テスト用の読み出しフック(既定は fs) */
  readArticle?: (path: string) => string;
}

/**
 * repoDir が未設定/非gitなら availability=false(UIで設定へ誘導)。
 * executor は commit-article のみ: articles/<slug>.md を書いて commit + push。
 */
/**
 * M73: 記事の公開(published: false → true)。
 *
 * これまで公開は「人間がZennの管理画面で押すもの」として構造的に禁じていた。だが
 * GitHub Release は**まったく同じ危険度なのにスマホから公開できる**(岩戸ゲートで
 * 全文と影響を確認したうえで)。同じ設計を Zenn にも通す: このアクションも executor は
 * 岩戸ゲートに封印されており、**人間が全文を読んで承認したときだけ**到達できる。
 *
 * frontmatter の published 行だけを差し替える(本文には触らない)
 */
export function publishArticleMarkdown(markdown: string): string | null {
  const m = /^(---\r?\n[\s\S]*?)^published:\s*false\s*$([\s\S]*)/m.exec(markdown);
  if (m === null) return null; // すでに true / frontmatter が無い
  return `${m[1]}published: true${m[2]}`;
}

export function createZennRepoAdapter(getRepoDir: () => string | null, deps: ZennRepoDeps): AdapterRuntime {
  const write =
    deps.writeArticle ??
    ((path: string, content: string): void => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content, 'utf8');
    });
  return {
    id: 'zenn-repo',
    capabilities: { read: false, search: false, draft: false, execute: ['commit-article', 'publish-article', 'redeploy-article'] },
    compliance:
      'Zenn記事はGitHub連携リポジトリ(zenn-content)へのコミットで反映される。下書きは published: false でのみコミットする。' +
      '公開(published: true)は publish-article アクションでのみ可能で、岩戸ゲートの承認(全文確認)を必ず通る',
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
      const repoDir = getRepoDir();
      if (repoDir === null || repoDir.trim() === '') throw new Error('zenn-contentのパスが未設定');

      if (action === 'publish-article') {
        // M73: 公開。ここへ来られるのは岩戸ゲートの承認(全文確認)を通ったときだけ
        const slug = String(params['slug'] ?? '');
        if (!ZENN_SLUG_RE.test(slug)) throw new Error(`Zennのslug規則に合わない: ${slug}`);
        const rel = `articles/${slug}.md`;
        const abs = join(repoDir, 'articles', `${slug}.md`);
        if (!existsSync(abs)) throw new Error(`記事が見つからない: ${rel}`);
        const current = deps.readArticle?.(abs) ?? readFileSync(abs, 'utf8');
        const published = publishArticleMarkdown(current);
        if (published === null) throw new Error(`${rel} は published: false ではない(すでに公開済みの可能性)`);
        write(abs, published);
        await deps.run(['add', rel], repoDir);
        await deps.run(['commit', '-m', `publish: ${slug}(published: true)`], repoDir);
        await deps.run(['push'], repoDir);
        return `zenn-content の ${rel} を published: true にして push した(Zennに反映されると誰でも読める)`;
      }

      if (action === 'redeploy-article') {
        // M77: published: true なのにZennが同期していない記事を、もう一度デプロイさせる。
        // Zennはpushを契機に同期するので、空コミットで叩き直す(記事の中身は一切変えない)。
        // 実機で「投稿数の上限に達したためデプロイされませんでした」が起き、
        // published: true のまま**誰も読めない**記事が、アプリからは手も足も出なくなった
        const slug = String(params['slug'] ?? '');
        if (!ZENN_SLUG_RE.test(slug)) throw new Error(`Zennのslug規則に合わない: ${slug}`);
        if (!existsSync(join(repoDir, 'articles', `${slug}.md`))) throw new Error(`記事が見つからない: ${slug}`);
        // M81: **空コミットではZennは何も再デプロイしない**(変更されたファイルが無いため、
        // 記事は同期対象にならない)。実機で空コミットをpushしても403のままだった。
        // Zennに「この記事は変わった」と認識させるには、その記事のファイル自体に差分が要る。
        // 本文は一切変えたくないので、末尾の改行1文字だけを足し引きする(表示は変わらない)
        const rel = `articles/${slug}.md`;
        const abs = join(repoDir, 'articles', `${slug}.md`);
        const md = deps.readArticle?.(abs) ?? readFileSync(abs, 'utf8');
        write(abs, md.endsWith('\n') ? md.slice(0, -1) : `${md}\n`);
        await deps.run(['add', rel], repoDir);
        await deps.run(['commit', '-m', `redeploy: ${slug}(Zennの同期をやり直す。本文は変えていない)`], repoDir);
        await deps.run(['push'], repoDir);
        return `${slug} の再デプロイを要求した(記事ファイルに末尾改行だけの差分を付けてpush。本文は変えていない)。Zennの同期には数分かかる。投稿数の上限に達している場合は、上限が戻るまで反映されない`;
      }

      if (action !== 'commit-article') throw new Error(`未知のアクション: ${action}`);
      const slug = String(params['slug'] ?? '');
      const markdown = String(params['markdown'] ?? '');
      if (!ZENN_SLUG_RE.test(slug)) throw new Error(`Zennのslug規則に合わない: ${slug}`);
      if (!/^---\r?\n/.test(markdown) || !/\npublished: false\r?\n/.test(markdown)) {
        // published: true の記事をこの経路で出すことは構造的に許さない
        throw new Error('記事に published: false のfrontmatterが無い(この経路では公開できない)');
      }
      // M75: **zenn-content は公開リポジトリ**。published: false は Zenn 上で非公開にするだけで、
      // GitHub上のファイルは誰でも読める。実際に月読(未公開機能)の内容がここから公開された。
      // 最後の砦として、未公開話題を含む記事は**コミットさせない**(承認済みでも通さない)
      if (mentionsUnreleased(markdown)) {
        throw new Error(
          '記事に未公開機能(月読)への言及が含まれている。zenn-contentは公開リポジトリのため、' +
            'published: false でもGitHub上で誰でも読める。この経路では出せない',
        );
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
