import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, MetricsSnapshot } from '../../shared/types';
import { GithubReader } from './adapters/github';
import { ZennReader } from './adapters/zenn';
import { parseCandidate, parseDrafts, strategyBoard, DraftStore } from './amenoUzume';
import { extractJson } from './llm';
import { OperationsManager } from './manager';
import { OmoiKami } from './omoiKami';
import { parseTriage, triageRepo } from './tedikaRao';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ops-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const jsonRes = (data: unknown, ok = true): { ok: boolean; status: number; json(): Promise<unknown> } => ({
  ok,
  status: ok ? 200 : 404,
  json: () => Promise.resolve(data),
});

describe('M32-3: OMOI-kami', () => {
  it('スナップショット収集: github+zenn+レジストリを集約し、時系列に追記する', async () => {
    const run = vi.fn(async (args: string[]) => {
      const api = args.join(' ');
      if (api === 'api repos/o/r') return JSON.stringify({ stargazers_count: 5, forks_count: 1, subscribers_count: 2, open_issues_count: 3 });
      if (api.includes('pulls?state=open')) return JSON.stringify([{}]);
      if (api.includes('traffic/views')) return JSON.stringify({ count: 100, uniques: 40 });
      if (api.includes('traffic/clones')) return JSON.stringify({ count: 7, uniques: 6 });
      if (api.includes('referrers')) return JSON.stringify([{ referrer: 'zenn.dev', count: 30, uniques: 20 }]);
      if (api.includes('releases')) return JSON.stringify([{ assets: [{ download_count: 9 }] }]);
      throw new Error(`unexpected: ${api}`);
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('zenn.dev/api/articles/my-slug')) {
        return jsonRes({ article: { liked_count: 12, comments_count: 3 } });
      }
      if (url.endsWith('/index.json')) return jsonRes({ plugins: [{}, {}] });
      return jsonRes(null, false);
    });
    const omoi = new OmoiKami(dir, { github: new GithubReader(run), zenn: new ZennReader(fetchImpl), fetchImpl });

    const snap = await omoi.collectSnapshot(
      { enabled: true, repos: ['o/r'], zennSlugs: ['my-slug'] },
      'https://example.com/registry',
    );
    expect(snap.github['o/r']).toMatchObject({ stars: 5, openPRs: 1, openIssues: 2, views: 100, downloads: 9 });
    expect(snap.github['o/r']?.referrers?.[0]).toMatchObject({ referrer: 'zenn.dev', count: 30 });
    expect(snap.zenn['my-slug']).toEqual({ liked: 12, comments: 3 });
    expect(snap.registry).toEqual({ plugins: 2 });

    // 2回目で history / latestPair が機能する
    await omoi.collectSnapshot({ enabled: true, repos: [], zennSlugs: [] });
    expect(omoi.history(10)).toHaveLength(2);
    const pair = omoi.latestPair();
    expect(pair.previous?.github['o/r']?.stars).toBe(5);
  });

  it('traffic不達(権限なし)でも基本メトリクスは成立する', async () => {
    const run = vi.fn(async (args: string[]) => {
      const api = args.join(' ');
      if (api === 'api repos/o/r') return JSON.stringify({ stargazers_count: 1, forks_count: 0, subscribers_count: 0, open_issues_count: 0 });
      if (api.includes('pulls?state=open')) return '[]';
      throw new Error('403');
    });
    const metrics = await new GithubReader(run).repoMetrics('o/r');
    expect(metrics.stars).toBe(1);
    expect(metrics.views).toBeUndefined();
  });

  it('週報プロンプトに時系列・referrer・投下履歴が含まれる', () => {
    const omoi = new OmoiKami(dir, { github: null, zenn: new ZennReader() });
    const snap: MetricsSnapshot = {
      ts: '2026-07-11T00:00:00Z',
      github: { 'o/r': { stars: 3, forks: 0, watchers: 1, openIssues: 0, openPRs: 0, referrers: [{ referrer: 'news.ycombinator.com', count: 50, uniques: 45 }] } },
      zenn: { slug: { liked: 8, comments: 1 } },
    };
    const prompt = omoi.buildWeeklyReportPrompt([snap], [
      { id: '1', kind: 'x-post', title: 'Show HN投稿', body: '', createdAt: '', status: 'posted', postedAt: '2026-07-10', media: 'hn' },
    ]);
    expect(prompt).toContain('news.ycombinator.com');
    expect(prompt).toContain('Show HN投稿');
    expect(prompt).toContain('♥8');
  });
});

describe('M32-4: AMENO-uzume', () => {
  it('extractJson: コードフェンス・前後の散文つきJSONを取り出せる', () => {
    expect(extractJson('前置き\n```json\n{"a":1}\n```\n後書き')).toEqual({ a: 1 });
    expect(extractJson('[{"kind":"x-post"}] 以上です')).toEqual([{ kind: 'x-post' }]);
    expect(extractJson('JSONなし')).toBeNull();
  });

  it('parseDrafts: 正常系+不正kind・空bodyの除外', () => {
    const raw = JSON.stringify([
      { kind: 'x-post', title: 'a', body: 'b' },
      { kind: 'evil', title: 'x', body: 'y' },
      { kind: 'release-note', title: '', body: 'z' },
    ]);
    const drafts = parseDrafts(raw);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: 'x-post' });
  });

  it('DraftStore: 追加→投稿済みマークで postedAt が刻まれる', () => {
    const store = new DraftStore(dir);
    const [d] = store.add([{ kind: 'x-post', title: 't', body: 'b' }]);
    expect(d).toBeDefined();
    const updated = store.update(d!.id, { status: 'posted', media: 'x' });
    expect(updated?.postedAt).toBeDefined();
    expect(store.list()[0]).toMatchObject({ status: 'posted', media: 'x' });
  });

  it('parseCandidate: match時のみ replyDraft を保持する', () => {
    const match = parseCandidate(
      JSON.stringify({ verdict: 'match', reasons: ['自作の作品を公開'], replyDraft: '面白い実験ですね' }),
      'x-paste',
      'プロフィール本文',
    );
    expect(match).toMatchObject({ verdict: 'match', replyDraft: '面白い実験ですね' });
    const noMatch = parseCandidate(
      JSON.stringify({ verdict: 'no-match', reasons: ['LINE誘導あり'], replyDraft: '不要' }),
      'x-paste',
      'p',
    );
    expect(noMatch?.replyDraft).toBeUndefined();
  });

  it('strategyBoard: 全媒体にnextActionが付き、初速フェーズではZennが種火提案になる', () => {
    const board = strategyBoard(null);
    expect(board.length).toBeGreaterThanOrEqual(6);
    expect(board.every((e) => e.nextAction.length > 0)).toBe(true);
    expect(board.find((e) => e.media === 'zenn')?.nextAction).toContain('初速');
  });
});

describe('M32-5: TEDIKA-rao', () => {
  it('triageRepo: PRはdiff付きでレビューされ、カード化される', async () => {
    const run = vi.fn(async (args: string[]) => {
      const api = args.join(' ');
      if (api.includes('issues?state=open')) {
        return JSON.stringify([
          { number: 2, title: 'add plugin', user: { login: 'alice' }, pull_request: {}, body: 'PR本文', labels: [] },
          { number: 1, title: 'bug report', user: { login: 'bob' }, body: 'Issue本文', labels: [{ name: 'bug' }] },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'diff') return '+ new code';
      throw new Error(`unexpected: ${api}`);
    });
    const llm = vi.fn(async (prompt: string) =>
      JSON.stringify({
        summary: prompt.includes('Pull Request') ? 'PRの要旨' : 'Issueの要旨',
        findings: [{ severity: 'high', note: '承認バイパスを含む' }],
        replyDraft: 'ありがとうございます',
        labels: ['registry'],
        recommendation: 'high解消までマージ不可',
      }),
    );
    const cards = await triageRepo('o/r', new GithubReader(run), llm);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ kind: 'pr', number: 2, summary: 'PRの要旨' });
    expect(cards[0]?.findings[0]?.severity).toBe('high');
    expect(llm.mock.calls[0]?.[0]).toContain('+ new code'); // diffがプロンプトに入る
  });

  it('LLM出力が壊れていても「手動確認」カードで生き残る', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args.join(' ').includes('issues?state=open')) {
        return JSON.stringify([{ number: 1, title: 't', user: { login: 'u' }, body: '', labels: [] }]);
      }
      return '[]';
    });
    const cards = await triageRepo('o/r', new GithubReader(run), async () => 'ぐちゃぐちゃの出力');
    expect(cards[0]?.recommendation).toBe('手動確認');
  });

  it('parseTriage: severity不正値はfindingsから除外される', () => {
    const card = parseTriage(
      JSON.stringify({ summary: 's', findings: [{ severity: 'critical', note: 'x' }, { severity: 'low', note: 'y' }], replyDraft: '', labels: [], recommendation: 'r' }),
      'o/r',
      { number: 1, title: 't', author: 'a', kind: 'issue', body: '', labels: [] },
    );
    expect(card?.findings).toHaveLength(1);
    expect(card?.findings[0]?.severity).toBe('low');
  });
});

describe('M34-1/2: はてブ+HN観測(旧形式互換込み)', () => {
  it('スナップショットに はてブ数(Zenn pathから自動導出+watchUrls)とHN karmaが載る', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('zenn.dev/api/articles/my-slug')) {
        return jsonRes({ article: { liked_count: 3, comments_count: 0, path: '/moriwo/articles/my-slug' } });
      }
      if (url.includes('bookmark.hatenaapis.com/count/entries')) {
        return jsonRes({
          'https://zenn.dev/moriwo/articles/my-slug': 4,
          'https://example.com/extra': 2,
        });
      }
      if (url.includes('firebaseio.com/v0/user/moriwo-dev-ai.json')) {
        return jsonRes({ karma: 5, submitted: [] });
      }
      return jsonRes(null, false);
    });
    const { HatenaReader } = await import('./adapters/hatena');
    const omoi = new OmoiKami(dir, {
      github: null,
      zenn: new ZennReader(fetchImpl),
      hatena: new HatenaReader(fetchImpl),
      fetchImpl,
    });
    const snap = await omoi.collectSnapshot({
      enabled: true,
      repos: [],
      zennSlugs: ['my-slug'],
      watchUrls: ['https://example.com/extra'],
      hnUser: 'moriwo-dev-ai',
    });
    expect(snap.hatena).toEqual({
      'https://zenn.dev/moriwo/articles/my-slug': 4,
      'https://example.com/extra': 2,
    });
    expect(snap.hn).toEqual({ karma: 5 });
    // はてブAPIへ渡ったURLにZenn由来の自動導出が含まれる
    const hatenaCall = fetchImpl.mock.calls.find(([u]) => (u as string).includes('hatenaapis'))?.[0] as string;
    expect(hatenaCall).toContain(encodeURIComponent('https://zenn.dev/moriwo/articles/my-slug'));
  });

  it('【互換】稼働中インスタンスが書いた旧形式スナップショット(hatena/hn無し)を読める', async () => {
    const { appendFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    // M33世代の実フォーマット(hatena/hnフィールドなし)
    appendFileSync(
      join(dir, 'metrics.jsonl'),
      `${JSON.stringify({ ts: '2026-07-11T06:07:58.855Z', github: { 'o/r': { stars: 0, forks: 0, watchers: 0, openIssues: 0, openPRs: 0 } }, zenn: { s: { liked: 2, comments: 0 } }, registry: { plugins: 1 } })}\n`,
      'utf8',
    );
    const omoi = new OmoiKami(dir, { github: null, zenn: new ZennReader() });
    const history = omoi.history(10);
    expect(history).toHaveLength(1);
    expect(history[0]?.zenn['s']?.liked).toBe(2);
    expect(history[0]?.hatena).toBeUndefined(); // 旧形式のまま壊れない
  });
});

describe('M32-1: オーナーモードゲート(manager)', () => {
  const makeManager = (enabled: boolean): OperationsManager =>
    new OperationsManager({
      userDataDir: dir,
      getConfig: () =>
        ({ operations: { enabled, repos: ['o/r'], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(false),
      bandProvider: () => 'キー未設定',
      ghRunner: async () => {
        throw new Error('gh呼び出しは発生しないはず(OFF時)');
      },
      fetchImpl: async () => {
        throw new Error('fetchは発生しないはず(OFF時)');
      },
    });

  it('オーナーモードOFF: status は enabled:false・アダプタ空で、収集も動かない', async () => {
    const manager = makeManager(false);
    const status = await manager.status();
    expect(status).toEqual({ enabled: false, ghDetected: false, ghPath: null, adapters: [], repos: [] });
    expect(await manager.collectSnapshot()).toBeNull();
    expect(manager.listDrafts()).toEqual([]);
    expect(manager.strategyBoard()).toEqual([]);
    const exec = await manager.execute('github', 'comment', 't', 'p', {});
    expect(exec.ok).toBe(false);
    expect(exec.detail).toContain('オーナーモード');
  });

  it('オーナーモードON: アダプタが登録され、xのexecuteは空宣言', async () => {
    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () =>
        ({ operations: { enabled: true, repos: [], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(false),
      bandProvider: () => 'キー未設定',
      ghRunner: async () => '[]',
    });
    const status = await manager.status();
    expect(status.enabled).toBe(true);
    // M33-5/7・M34-1: god-definition(定義変更=承認必須)/hn/hatena(read専用)も登録される
    // M37: zenn-repo(記事コミット。パス未設定なら availability=false)
    expect(status.adapters.map((a) => a.id).sort()).toEqual([
      'bluesky',
      'github',
      'god-definition',
      'hatena',
      'hn',
      'x',
      'zenn',
      'zenn-repo',
    ]);
    expect(status.adapters.find((a) => a.id === 'x')?.capabilities.execute).toEqual([]);
  });

  it('M36-1: ユーザー手動設定の予算は神議の自律引き下げより優先される', async () => {
    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () =>
        ({ operations: { enabled: true, repos: [], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(false),
      bandProvider: () => 'キー未設定',
      ghRunner: async () => '[]',
    });
    await manager.status();
    // ユーザーがUI経由(updateClock)で手動設定 — 引き上げでも承認不要
    const updated = manager.updateClock('uzume-patrol', { dailyTokenBudget: 50_000 });
    expect(updated?.budgetSetByUser).toBe(true);
    // 神議の自律引き下げは拒否される(applyAutonomousChange経由)
    const detail = (
      manager as unknown as { applyAutonomousChange: (c: unknown) => string }
    ).applyAutonomousChange({ kind: 'budget-decrease', godId: 'uzume-patrol', reason: '節約', value: 1000 });
    expect(detail).toContain('手動設定');
    expect(manager.clocks().find((j) => j.id === 'uzume-patrol')?.dailyTokenBudget).toBe(50_000);
  });

  it('M34-2: 自分のHNコメントへの返信を検知し、全文つきで受け箱へ(2回目の巡回で差分)', async () => {
    const kids: number[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/v0/user/moriwo-dev-ai.json')) return jsonRes({ karma: 1, submitted: [100] });
      if (url.includes('/v0/item/100.json')) {
        return jsonRes({ id: 100, type: 'comment', by: 'moriwo-dev-ai', text: 'my comment', kids: [...kids] });
      }
      if (url.includes('/v0/item/200.json')) {
        return jsonRes({ id: 200, type: 'comment', by: 'alice', text: '<p>great project!</p>' });
      }
      return jsonRes(null, false);
    });
    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () =>
        ({
          operations: { enabled: true, repos: [], zennSlugs: [], hnUser: 'moriwo-dev-ai' },
        }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(false),
      bandProvider: () => 'キー未設定',
      ghRunner: async () => '[]',
      fetchImpl,
    });
    // 1回目: 基準線の確立(返信なし)
    await manager.collectSnapshot(); // 初期化を確実に
    const run = (
      manager as unknown as { runGod: (id: string) => Promise<{ ok: boolean; detail: string }> }
    ).runGod.bind(manager);
    await run('omoi-kami');
    // 2回目: 返信(kid 200)が付いた
    kids.push(200);
    await run('omoi-kami');
    const replies = manager.inboxList(50).filter((i) => i.kind === 'hn-reply');
    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0]?.title).toContain('@alice');
    expect(String(replies[0]?.payload['fullText'])).toContain('great project');
  });
});
