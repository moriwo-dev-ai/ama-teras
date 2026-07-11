import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../shared/types';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import { createGithubAdapter } from './adapters/github';
import {
  articleSlug,
  buildArticleMarkdown,
  createZennRepoAdapter,
  ZENN_SLUG_RE,
  type GitRunner,
} from './adapters/zennRepo';
import { DraftStore } from './amenoUzume';
import { OperationsManager } from './manager';
import { IwatoGate } from './protocol';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ops-dest-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 承認プロンプトを固定した岩戸ゲート(承認=approve) */
const gateWith = (approve: boolean): { gate: IwatoGate; audit: { approved: boolean; detail: string }[] } => {
  const audit: { approved: boolean; detail: string }[] = [];
  const gate = new IwatoGate(
    () => Promise.resolve(approve),
    (e) => audit.push({ approved: e.approved, detail: e.detail }),
  );
  return { gate, audit };
};

describe('M37-1: GitHub Release(リリースノートの行き先)', () => {
  it('新規タグは --draft で作成する(公開は人間)', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'release' && args[1] === 'view') throw new Error('release not found');
      return '';
    });
    const { gate } = gateWith(true);
    gate.register(createGithubAdapter(run, () => true));
    const res = await gate.requestExecute('github', 'release', 'o/r v1.0.1', 'note', {
      repo: 'o/r',
      tag: 'v1.0.1',
      title: 'v1.0.1',
      body: '- 修正',
    });
    expect(res.ok).toBe(true);
    const created = run.mock.calls.map((c) => c[0]).find((a) => a[1] === 'create')!;
    expect(created).toContain('--draft');
    expect(created).toContain('v1.0.1');
    expect(created).toContain('- 修正');
  });

  it('既存タグは edit(本文更新のみ。公開状態は触らない)', async () => {
    const run = vi.fn(async (_args: string[]) => '{"tagName":"v1.0.0"}');
    const { gate } = gateWith(true);
    gate.register(createGithubAdapter(run, () => true));
    const res = await gate.requestExecute('github', 'release', 'o/r v1.0.0', 'note', {
      repo: 'o/r',
      tag: 'v1.0.0',
      title: 't',
      body: 'b',
    });
    expect(res.ok).toBe(true);
    const args = run.mock.calls.map((c) => c[0]);
    expect(args.some((a) => a[1] === 'edit')).toBe(true);
    expect(args.some((a) => a[1] === 'create')).toBe(false);
  });

  it('承認しなければ gh は一度も呼ばれない(岩戸の掟)', async () => {
    const run = vi.fn(async () => '');
    const { gate } = gateWith(false);
    gate.register(createGithubAdapter(run, () => true));
    const res = await gate.requestExecute('github', 'release', 'o/r v9', 'note', { repo: 'o/r', tag: 'v9' });
    expect(res.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('M37-2: zenn-repo アダプタ(記事の行き先)', () => {
  it('slug: 英数タイトルはslug化、日本語タイトルはスタンプ名に落ちる。どちらもZenn規則を満たす', () => {
    const stamp = '202607121530';
    expect(articleSlug('Self Evolving Agent', stamp)).toMatch(ZENN_SLUG_RE);
    expect(articleSlug('Self Evolving Agent', stamp)).toContain('self-evolving-agent');
    const ja = articleSlug('自己進化エージェントの作り方', stamp);
    expect(ja).toBe(`ama-teras-${stamp}`);
    expect(ja).toMatch(ZENN_SLUG_RE);
    // 短すぎる英数タイトルもスタンプが付いて12文字以上になる
    expect(articleSlug('ab', stamp)).toMatch(ZENN_SLUG_RE);
  });

  it('frontmatter は必ず published: false', () => {
    const md = buildArticleMarkdown(
      { title: '記事"タイトル"', emoji: '⛩️', type: 'tech', topics: ['ai', 'electron'] },
      '## 見出し\n本文',
    );
    expect(md).toContain('published: false');
    expect(md).toContain('topics: ["ai", "electron"]');
    expect(md).not.toContain('published: true');
    expect(md.startsWith('---\n')).toBe(true);
  });

  it('承認後: articles/<slug>.md を書き、add→commit→push する', async () => {
    const repoDir = join(dir, 'zenn-content');
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    const run = vi.fn<GitRunner>(async () => '');
    const { gate } = gateWith(true);
    gate.register(createZennRepoAdapter(() => repoDir, { run }));
    const markdown = buildArticleMarkdown(
      { title: 't', emoji: '⛩️', type: 'tech', topics: ['ai'] },
      '## 本文',
    );
    const slug = 'ama-teras-202607121530';
    const res = await gate.requestExecute('zenn-repo', 'commit-article', 'articles', markdown, {
      slug,
      markdown,
    });
    expect(res.ok).toBe(true);
    const written = join(repoDir, 'articles', `${slug}.md`);
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf8')).toContain('published: false');
    expect(run.mock.calls.map((c) => c[0][0])).toEqual(['add', 'commit', 'push']);
  });

  it('published: true の記事はこの経路では発行できない(コミットもpushもしない)', async () => {
    const repoDir = join(dir, 'zenn-content');
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    const run = vi.fn<GitRunner>(async () => '');
    const { gate } = gateWith(true);
    gate.register(createZennRepoAdapter(() => repoDir, { run }));
    const bad = '---\ntitle: "t"\npublished: true\n---\n\n本文\n';
    const res = await gate.requestExecute('zenn-repo', 'commit-article', 'articles', bad, {
      slug: 'ama-teras-202607121530',
      markdown: bad,
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('published: false');
    expect(run).not.toHaveBeenCalled();
  });

  it('パス未設定なら availability=false(UIで設定へ誘導)', async () => {
    const { gate } = gateWith(true);
    gate.register(createZennRepoAdapter(() => null, { run: async () => '' }));
    const status = await gate.status();
    const zennRepo = status.find((a) => a.id === 'zenn-repo')!;
    expect(zennRepo.available).toBe(false);
    expect(zennRepo.detail).toContain('未設定');
  });
});

describe('M37-3: manager(下書き→行き先。種類の取り違えを拒否)', () => {
  /** 記事本文を返すだけのLLM */
  const fakeLLM: LLMProvider = {
    id: 'anthropic',
    async *complete(): AsyncGenerator<ProviderEvent> {
      yield { type: 'text_delta', text: '## 章\n本文' };
      yield {
        type: 'message_done',
        usage: { inputTokens: 10, outputTokens: 20 },
        stopReason: 'end_turn',
      } as ProviderEvent;
    },
  };

  const makeManager = (
    over: {
      approve?: boolean;
      zennRepoDir?: string;
      ghRunner?: (args: string[]) => Promise<string>;
      gitRunner?: GitRunner;
    } = {},
  ): OperationsManager =>
    new OperationsManager({
      userDataDir: dir,
      getConfig: () =>
        ({
          operations: {
            enabled: true,
            repos: ['o/r'],
            zennSlugs: [],
            ...(over.zennRepoDir !== undefined ? { zennRepoDir: over.zennRepoDir } : {}),
          },
        }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(over.approve ?? true),
      bandProvider: () => fakeLLM,
      ghRunner: over.ghRunner ?? (async () => ''),
      ...(over.gitRunner !== undefined ? { gitRunner: over.gitRunner } : {}),
    });

  /** manager と同じ userData を見る DraftStore(下書きの直接投入用) */
  const store = (): DraftStore => new DraftStore(join(dir, 'operations'));

  it('X投稿の下書きを GitHub Release に流そうとしても拒否される(種類はコードで固定)', async () => {
    const manager = makeManager();
    manager.listDrafts(); // 初期化
    const [draft] = store().add([{ kind: 'x-post', title: 't', body: 'b' }]);
    const res = await manager.requestRelease(draft!.id, 'o/r', 'v1.0.1');
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('リリースノートではない');
  });

  it('観測対象外のリポジトリ・不正なタグは承認ダイアログにすら出さない', async () => {
    const prompt = vi.fn(() => Promise.resolve(true));
    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () =>
        ({ operations: { enabled: true, repos: ['o/r'], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: prompt,
      bandProvider: () => fakeLLM,
      ghRunner: async () => '',
    });
    manager.listDrafts();
    const [draft] = store().add([{ kind: 'release-note', title: 'v1.0.1', body: '- 修正' }]);
    expect((await manager.requestRelease(draft!.id, 'other/repo', 'v1.0.1')).ok).toBe(false);
    expect((await manager.requestRelease(draft!.id, 'o/r', 'v1 .0;rm -rf')).ok).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('リリースノート → 承認 → gh release create --draft', async () => {
    const gh = vi.fn(async (args: string[]) => {
      if (args[1] === 'view') throw new Error('not found');
      return '';
    });
    const manager = makeManager({ ghRunner: gh });
    manager.listDrafts();
    const [draft] = store().add([{ kind: 'release-note', title: 'v1.0.1', body: '- 修正' }]);
    const res = await manager.requestRelease(draft!.id, 'o/r', 'v1.0.1');
    expect(res.ok).toBe(true);
    expect(gh.mock.calls.some((c) => c[0][1] === 'create' && c[0].includes('--draft'))).toBe(true);
  });

  it('Zenn記事化: パス未設定なら実行に進まない', async () => {
    const manager = makeManager();
    manager.listDrafts();
    const [draft] = store().add([{ kind: 'article-outline', title: 'タイトル', body: '## 章' }]);
    const res = await manager.requestZennArticle(draft!.id);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('未設定');
  });

  it('Zenn記事化: 未承認なら push されず、本文の下書き(article-body)は残る(コピーして使える)', async () => {
    const repoDir = join(dir, 'zenn-content');
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    const git = vi.fn<GitRunner>(async () => '');
    const manager = makeManager({ approve: false, zennRepoDir: repoDir, gitRunner: git });
    manager.listDrafts();
    const [draft] = store().add([{ kind: 'article-outline', title: 'タイトル', body: '## 章' }]);
    const res = await manager.requestZennArticle(draft!.id);
    expect(res.ok).toBe(false);
    expect(git).not.toHaveBeenCalled();
    const body = manager.listDrafts().find((d) => d.kind === 'article-body');
    expect(body?.body).toContain('published: false');
    expect(res.bodyDraftId).toBe(body?.id);
  });

  it('Zenn記事化: 承認 → published:false でコミット・push', async () => {
    const repoDir = join(dir, 'zenn-content');
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    const git = vi.fn<GitRunner>(async () => '');
    const manager = makeManager({ approve: true, zennRepoDir: repoDir, gitRunner: git });
    manager.listDrafts();
    const [draft] = store().add([{ kind: 'article-outline', title: 'タイトル', body: '## 章' }]);
    const res = await manager.requestZennArticle(draft!.id);
    expect(res.ok).toBe(true);
    expect(git.mock.calls.map((c) => c[0][0])).toEqual(['add', 'commit', 'push']);
    const added = git.mock.calls[0]![0][1]!;
    expect(added.startsWith('articles/')).toBe(true);
    expect(readFileSync(join(repoDir, added), 'utf8')).toContain('published: false');
  });
});
