import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalBatch, AppConfig, MetricsSnapshot, OperationsDraft } from '../../shared/types';
import { DraftStore } from './amenoUzume';
import { computeImpacts, isFlat, summarize, totals } from './impact';
import { OperationsManager } from './manager';
import { GodScheduler, type GodClockJob } from './scheduler';
import { OpsThread } from './thread';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'impact-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const snap = (ts: string, stars: number, liked = 0): MetricsSnapshot => ({
  ts,
  github: { 'o/r': { stars, forks: 0, watchers: 0, openIssues: 0, openPRs: 0 } },
  zenn: { s: { liked, comments: 0 } },
});

const posted = (over: Partial<OperationsDraft> = {}): OperationsDraft => ({
  id: 'd1',
  kind: 'x-post',
  title: 'リリース告知',
  body: '公開した https://github.com/o/r',
  createdAt: '2026-07-10T00:00:00Z',
  status: 'posted',
  postedAt: '2026-07-10T12:00:00Z',
  media: 'x',
  ...over,
});

describe('M38-3: 発信の効果測定(投稿→前後差分)', () => {
  it('投稿直前のスナップショットと計測窓後のスナップショットで差分を出す', () => {
    const history = [
      snap('2026-07-10T06:00:00Z', 3, 1), // before(投稿前で最も新しい)
      snap('2026-07-10T18:00:00Z', 5, 2), // 窓の途中(採用しない)
      snap('2026-07-11T13:00:00Z', 9, 4), // after(postedAt+24h 以降で最も古い)
      snap('2026-07-12T00:00:00Z', 20, 9), // それ以降(採用しない)
    ];
    const [entry] = computeImpacts([posted()], history, new Date('2026-07-12T01:00:00Z'));
    expect(entry?.measurable).toBe(true);
    expect(entry?.delta).toMatchObject({ stars: 6, zennLiked: 3 });
    expect(entry?.url).toBe('https://github.com/o/r');
    expect(summarize(entry!)).toContain('★+6');
  });

  it('計測窓が閉じていなければ measurable=false(残り時間を出す)', () => {
    const history = [snap('2026-07-10T06:00:00Z', 3)];
    const [entry] = computeImpacts([posted()], history, new Date('2026-07-10T18:00:00Z'));
    expect(entry?.measurable).toBe(false);
    expect(entry?.note).toContain('計測中');
    expect(entry?.delta).toBeNull();
  });

  it('観測神が止まっていて投稿前スナップショットが無い場合は正直に「測れない」と言う', () => {
    const history = [snap('2026-07-11T13:00:00Z', 9)];
    const [entry] = computeImpacts([posted()], history, new Date('2026-07-12T00:00:00Z'));
    expect(entry?.measurable).toBe(false);
    expect(entry?.note).toContain('投稿前のスナップショットが無い');
  });

  it('変化ゼロを「効果あり」に見せない(±0と明示)', () => {
    const history = [snap('2026-07-10T06:00:00Z', 3, 1), snap('2026-07-11T13:00:00Z', 3, 1)];
    const [entry] = computeImpacts([posted()], history, new Date('2026-07-12T00:00:00Z'));
    expect(isFlat(entry!.delta!)).toBe(true);
    expect(summarize(entry!)).toContain('変化なし');
  });

  it('totals: リポジトリ・記事をまたいで合算する', () => {
    const s: MetricsSnapshot = {
      ts: '2026-07-10T00:00:00Z',
      github: {
        a: { stars: 2, forks: 0, watchers: 0, openIssues: 0, openPRs: 0, downloads: 5, views: 10 },
        b: { stars: 3, forks: 0, watchers: 0, openIssues: 0, openPRs: 0 },
      },
      zenn: { x: { liked: 2, comments: 1 }, y: { liked: 1, comments: 0 } },
      hatena: { 'https://a': 4 },
    };
    expect(totals(s)).toEqual({
      stars: 5,
      zennLiked: 3,
      zennComments: 1,
      hatena: 4,
      downloads: 5,
      views: 10,
    });
  });

  it('manager.impacts(): 投稿済み下書きのみが対象(下書き・破棄は測らない)', () => {
    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () =>
        ({ operations: { enabled: true, repos: [], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(false),
      bandProvider: () => 'キー未設定',
      ghRunner: async () => '[]',
    });
    manager.listDrafts(); // 初期化
    const store = new DraftStore(join(dir, 'operations'));
    const [a, b] = store.add([
      { kind: 'x-post', title: '投稿した', body: 'b' },
      { kind: 'x-post', title: '下書きのまま', body: 'b' },
    ]);
    store.update(a!.id, { status: 'posted' });
    expect(b?.status).toBe('draft');
    const impacts = manager.impacts();
    expect(impacts).toHaveLength(1);
    expect(impacts[0]?.title).toBe('投稿した');
  });
});

describe('M38-2: 神議 → 進化の配線(承認された能力ギャップの自動起票)', () => {
  const gapBatch = (branch: 'evolve' | 'adhoc'): ApprovalBatch => ({
    id: 'b1',
    ts: new Date().toISOString(),
    analysis: 'test',
    items: [
      {
        id: 'i1',
        kind: 'capability-gap',
        title: '発信後の反応を自動追跡したい',
        detail: '投稿URL→前後メトリクス差分を自動記録する機能',
        gap: { branch },
        status: 'pending',
      },
    ],
  });

  const makeManager = (enqueue?: (d: string, io: string) => Promise<number>): OperationsManager =>
    new OperationsManager({
      userDataDir: dir,
      getConfig: () =>
        ({ operations: { enabled: true, repos: [], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(true),
      bandProvider: () => 'キー未設定',
      ghRunner: async () => '[]',
      ...(enqueue !== undefined ? { enqueueEvolution: enqueue } : {}),
    });

  it('evolve を承認すると進化ジョブが起票され、受け箱にジョブ番号が残る', async () => {
    const enqueue = vi.fn(async (_d: string, _io: string) => 42);
    const manager = makeManager(enqueue);
    await manager.status();
    new OpsThread(join(dir, 'operations')).addBatch(gapBatch('evolve'));

    const result = await manager.batchRespond('b1', 'i1', true);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('#42');
    expect(enqueue).toHaveBeenCalledTimes(1);
    // 依頼文(detail)がそのまま expectedIO として進化ジョブへ渡る
    expect(enqueue.mock.calls[0]?.[1]).toContain('前後メトリクス差分');
    expect(manager.inboxList().some((i) => i.kind === 'evolution' && i.title.includes('#42'))).toBe(true);
  });

  it('承認しなければ進化ジョブは起票されない(人間の承認が唯一の引き金)', async () => {
    const enqueue = vi.fn(async () => 1);
    const manager = makeManager(enqueue);
    await manager.status();
    new OpsThread(join(dir, 'operations')).addBatch(gapBatch('evolve'));
    await manager.batchRespond('b1', 'i1', false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('adhoc は進化を起票しない(単発カバーの案内のみ)', async () => {
    const enqueue = vi.fn(async () => 1);
    const manager = makeManager(enqueue);
    await manager.status();
    new OpsThread(join(dir, 'operations')).addBatch(gapBatch('adhoc'));
    const result = await manager.batchRespond('b1', 'i1', true);
    expect(result.ok).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('M38-1: 予算ロックの解錠(🔓 神議へ調整権限を返す)', () => {
  const baseJob = (): GodClockJob => ({
    id: 'j1',
    godId: 'omoi-kami',
    intervalMin: 360,
    enabled: true,
    dailyTokenBudget: 10_000,
    spentToday: 0,
  });

  it('ユーザー設定で施錠(🔒)、解錠すると budgetSetByUser が消えて値は残る', () => {
    const sched = new GodScheduler(
      join(dir, 'schedule.json'),
      vi.fn(),
      { onBudgetAlert: () => {}, onJobRun: () => {} },
      () => new Date('2026-07-12T09:00:00'),
    );
    sched.ensureJobs([baseJob()]);
    sched.update('j1', { dailyTokenBudget: 50_000 }, { byUser: true });
    expect(sched.list()[0]?.budgetSetByUser).toBe(true);

    // 🔓 解錠: 予算値はそのまま、優先フラグだけ落ちる
    const unlocked = sched.update('j1', { budgetSetByUser: false });
    expect(unlocked?.budgetSetByUser).toBeUndefined();
    expect(unlocked?.dailyTokenBudget).toBe(50_000);

    // 永続化されている(再ロードしてもロックは戻らない)
    const reloaded = new GodScheduler(join(dir, 'schedule.json'), vi.fn(), {
      onBudgetAlert: () => {},
      onJobRun: () => {},
    });
    expect(reloaded.list()[0]?.budgetSetByUser).toBeUndefined();
  });

  it('解錠後は再び手動設定で施錠できる(トグルの往復)', () => {
    const sched = new GodScheduler(
      join(dir, 'schedule.json'),
      vi.fn(),
      { onBudgetAlert: () => {}, onJobRun: () => {} },
      () => new Date('2026-07-12T09:00:00'),
    );
    sched.ensureJobs([baseJob()]);
    sched.update('j1', { dailyTokenBudget: 20_000 }, { byUser: true });
    sched.update('j1', { budgetSetByUser: false });
    sched.update('j1', { dailyTokenBudget: 30_000 }, { byUser: true });
    expect(sched.list()[0]?.budgetSetByUser).toBe(true);
    expect(sched.list()[0]?.dailyTokenBudget).toBe(30_000);
  });
});
