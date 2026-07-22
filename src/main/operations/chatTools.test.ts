import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvolutionJobSummary, MetricsSnapshot, OperationsDraft } from '../../shared/types';
import { CHAT_TOOL_SPECS, executeChatTool, parseToolCall, type ChatToolDeps } from './chatTools';

/**
 * M99-13: 運営チャットの読み取り専用ツール。
 * 掟: 読むのは自由、変えるのは承認 — ここに書き込み系ツールが生えたらこのテストで気づけるよう、
 * 一覧の名前も固定する。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chattools-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SNAP: MetricsSnapshot = {
  ts: '2026-07-22T06:59:00.000Z',
  github: {
    'o/ama-teras': { stars: 0, forks: 0, views: 69, viewsUnique: 10, clones: 554, clonesUnique: 216, downloads: 10 },
  },
  zenn: { 'my-article': { liked: 4, comments: 0, path: '/moriwo_dev_ai/articles/my-article' } },
} as unknown as MetricsSnapshot;

function deps(over: Partial<ChatToolDeps> = {}): ChatToolDeps {
  return {
    ghRun: null,
    repos: ['o/ama-teras'],
    metricsHistory: () => [SNAP],
    draftsList: () => [],
    evolutionJobs: () => [],
    zennArticlesDir: null,
    fetchImpl: () => Promise.resolve({ status: 200 }),
    ...over,
  };
}

describe('M99-13: ツール一覧は読み取り専用のみ', () => {
  it('書き込みを匂わせる名前が無い(post/create/delete/merge/publish/write)', () => {
    for (const s of CHAT_TOOL_SPECS) {
      expect(s.name).not.toMatch(/post|create|delete|merge|publish|write|update/);
    }
    expect(CHAT_TOOL_SPECS.map((s) => s.name)).toEqual([
      'github_traffic',
      'metrics_history',
      'evolution_jobs',
      'drafts_all',
      'zenn_reachability',
    ]);
  });
});

describe('M99-13: parseToolCall', () => {
  it('ツール呼び出しを取り出し、本文からタグを除く', () => {
    const { body, call } = parseToolCall('調べます。\n<tool>{"name":"metrics_history","args":{}}</tool>');
    expect(call).toEqual({ name: 'metrics_history', args: {} });
    expect(body).toBe('調べます。');
  });

  it('未知ツール・壊れたJSONは呼び出し無し扱い(本文は生かす)', () => {
    expect(parseToolCall('x <tool>{"name":"rm_rf","args":{}}</tool>').call).toBeNull();
    expect(parseToolCall('x <tool>{壊}</tool>').call).toBeNull();
    expect(parseToolCall('普通の返事').call).toBeNull();
  });
});

describe('M99-13: executeChatTool', () => {
  it('metrics_history は clone 入りの時系列を返す', async () => {
    const out = await executeChatTool({ name: 'metrics_history', args: {} }, deps());
    expect(out).toContain('clone554(u216)');
  });

  it('github_traffic: gh未検出は明示、gh有りは4種の実測を束ねる', async () => {
    expect(await executeChatTool({ name: 'github_traffic', args: {} }, deps())).toContain('gh CLI が見つからない');
    const calls: string[] = [];
    const out = await executeChatTool(
      { name: 'github_traffic', args: {} },
      deps({
        ghRun: (args) => {
          calls.push(args.join(' '));
          return Promise.resolve('[]');
        },
      }),
    );
    expect(out).toContain('流入元referrer');
    expect(calls.some((c) => c.includes('traffic/popular/referrers'))).toBe(true);
    expect(calls.some((c) => c.includes('traffic/clones'))).toBe(true);
  });

  it('evolution_jobs はゲートと失敗理由つきで一覧する', async () => {
    const jobs = [
      { id: 45, status: 'failed', description: 'core修正', log: [], gates: [{ name: 'typecheck', ok: false, detail: '' }], error: 'モデル名が不正' },
    ] as unknown as EvolutionJobSummary[];
    const out = await executeChatTool({ name: 'evolution_jobs', args: {} }, deps({ evolutionJobs: () => jobs }));
    expect(out).toContain('#45 [failed]');
    expect(out).toContain('❌typecheck');
    expect(out).toContain('モデル名が不正');
  });

  it('drafts_all は状態別件数を返す', async () => {
    const drafts = [
      { id: '1', kind: 'x-post', title: 'a', body: '', createdAt: '', status: 'draft' },
      { id: '2', kind: 'release-note', title: 'b', body: '', createdAt: '', status: 'posted' },
    ] as unknown as OperationsDraft[];
    const out = await executeChatTool({ name: 'drafts_all', args: {} }, deps({ draftsList: () => drafts }));
    expect(out).toContain('"draft":1');
    expect(out).toContain('"posted":1');
  });

  it('zenn_reachability: published:true だけ実測し、読めない記事を名指しする', async () => {
    const articles = join(dir, 'articles');
    mkdirSync(articles, { recursive: true });
    writeFileSync(join(articles, 'ok-article.md'), '---\ntitle: "a"\npublished: true\n---\n本文');
    writeFileSync(join(articles, 'blocked-article.md'), '---\ntitle: "b"\npublished: true\n---\n本文');
    writeFileSync(join(articles, 'draft-article.md'), '---\ntitle: "c"\npublished: false\n---\n本文');
    const out = await executeChatTool(
      { name: 'zenn_reachability', args: {} },
      deps({
        zennArticlesDir: articles,
        fetchImpl: (url) => Promise.resolve({ status: url.includes('blocked-article') ? 403 : 200 }),
      }),
    );
    // ユーザー名は観測台帳のZennパスから割り出す
    expect(out).toContain('zenn.dev/moriwo_dev_ai');
    expect(out).toContain('ok-article: HTTP 200 (読める)');
    expect(out).toContain('blocked-article: HTTP 403 (読めない!');
    expect(out).toContain('draft-article: (published:false=下書き。未公開は正常)');
  });

  it('未知のツールはエラー文字列(例外を投げない)', async () => {
    const out = await executeChatTool({ name: 'nope', args: {} }, deps());
    expect(out).toContain('未知のツール');
  });
});
