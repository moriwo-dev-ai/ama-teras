import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Inbox } from './inbox';
import {
  addSpent,
  clampIntervalMin,
  computeNextRun,
  GodScheduler,
  INTERVAL_MIN_FLOOR,
  isDue,
  isOverBudget,
  restoreIntervalIfNewDay,
  widenIntervalForBudget,
  type GodClockJob,
} from './scheduler';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sched-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const baseJob = (over: Partial<GodClockJob> = {}): GodClockJob => ({
  id: 'j1',
  godId: 'omoi-kami',
  intervalMin: 360,
  enabled: true,
  dailyTokenBudget: 10_000,
  spentToday: 0,
  ...over,
});

describe('M33-1: スケジューラ純関数', () => {
  it('interval時計: lastRun + interval が次回。クランプ下限=ユーザー保護', () => {
    const now = new Date('2026-07-11T12:00:00');
    const next = computeNextRun(baseJob({ lastRun: '2026-07-11T12:00:00' }), now);
    expect(next.toISOString()).toBe(new Date('2026-07-11T18:00:00').toISOString());
    expect(clampIntervalMin(1)).toBe(INTERVAL_MIN_FLOOR); // 神議も1分間隔にはできない
    expect(clampIntervalMin(999999)).toBe(24 * 60);
  });

  it('dailyTimes時計: 今日の残りで最も早い時刻、過ぎていれば明日', () => {
    const job = baseJob({ dailyTimes: ['09:00', '21:00'] });
    const morning = computeNextRun(job, new Date('2026-07-11T08:00:00'));
    expect(morning.getHours()).toBe(9);
    const noon = computeNextRun(job, new Date('2026-07-11T12:00:00'));
    expect(noon.getHours()).toBe(21);
    const night = computeNextRun(job, new Date('2026-07-11T22:00:00'));
    expect(night.getHours()).toBe(9);
    expect(night.getDate()).toBe(12); // 翌日
  });

  it('isDue: 無効ジョブは期限が来ても実行しない。nextRun未設定は初回実行', () => {
    const now = new Date('2026-07-11T12:00:00');
    expect(isDue(baseJob({ enabled: false, nextRun: '2026-07-11T11:00:00' }), now)).toBe(false);
    expect(isDue(baseJob(), now)).toBe(true);
    expect(isDue(baseJob({ nextRun: '2026-07-11T11:00:00' }), now)).toBe(true);
    expect(isDue(baseJob({ nextRun: '2026-07-11T13:00:00' }), now)).toBe(false);
  });

  it('予算: 日内加算・日替わりリセット・超過判定(0=無制限)', () => {
    const now = new Date('2026-07-11T12:00:00');
    let job = addSpent(baseJob(), 6000, now);
    expect(job.spentToday).toBe(6000);
    expect(isOverBudget(job)).toBe(false);
    job = addSpent(job, 5000, now);
    expect(isOverBudget(job)).toBe(true);
    // 日替わりでリセット
    const nextDay = restoreIntervalIfNewDay(job, new Date('2026-07-12T00:01:00'));
    expect(nextDay.spentToday).toBe(0);
    expect(isOverBudget(nextDay)).toBe(false);
    // 無制限
    expect(isOverBudget(addSpent(baseJob({ dailyTokenBudget: 0 }), 999999, now))).toBe(false);
  });

  it('予算超過→間隔倍化(上限クランプ)、日替わりで基準に復元。dailyTimes神議は倍化しない', () => {
    let job = widenIntervalForBudget(baseJob({ intervalMin: 360, spentDate: '2026-07-11' }));
    expect(job.intervalMin).toBe(720);
    expect(job.baseIntervalMin).toBe(360);
    job = widenIntervalForBudget(job);
    expect(job.intervalMin).toBe(1440); // 24h上限
    const restored = restoreIntervalIfNewDay(job, new Date('2026-07-12T00:01:00'));
    expect(restored.intervalMin).toBe(360);
    expect(restored.baseIntervalMin).toBeUndefined();
    const kamu = widenIntervalForBudget(baseJob({ dailyTimes: ['09:00'] }));
    expect(kamu.intervalMin).toBe(360); // 変わらない
  });
});

describe('M33-1: GodScheduler(tick統合)', () => {
  it('期限ジョブのみ実行し、消費を記録、超過で予算警告+倍化+同日中は実行停止', async () => {
    let now = new Date('2026-07-11T12:00:00');
    const runner = vi.fn().mockResolvedValue({ ok: true, detail: 'done', tokensUsed: 9000 });
    const alerts: GodClockJob[] = [];
    const sched = new GodScheduler(
      join(dir, 'schedule.json'),
      runner,
      { onBudgetAlert: (j) => alerts.push(j), onJobRun: () => {} },
      () => now,
    );
    sched.ensureJobs([
      // 1回の実行(9000)で予算8000を超える=即座に警告+倍化の経路を踏む
      baseJob({ id: 'due', godId: 'omoi-kami', intervalMin: 60, dailyTokenBudget: 8000 }),
      baseJob({ id: 'later', godId: 'tedika-rao', nextRun: '2026-07-11T13:00:00' }),
    ]);

    await sched.tick();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith('omoi-kami');
    const due = sched.list().find((j) => j.id === 'due')!;
    expect(due.spentToday).toBe(9000);
    expect(alerts).toHaveLength(1);
    expect(due.intervalMin).toBe(120); // 60→倍化
    expect(isOverBudget(due)).toBe(true);

    // 超過中は同日内で期限が来ても実行しない(14:01。翌日リセットは別テスト)
    now = new Date('2026-07-11T14:01:00');
    runner.mockClear();
    await sched.tick();
    expect(runner.mock.calls.map((c) => c[0])).not.toContain('omoi-kami');
  });

  it('runner例外でもスケジューラは死なず、次回が予約される', async () => {
    const now = new Date('2026-07-11T12:00:00');
    const sched = new GodScheduler(
      join(dir, 'schedule.json'),
      vi.fn().mockRejectedValue(new Error('api down')),
      { onBudgetAlert: () => {}, onJobRun: () => {} },
      () => now,
    );
    sched.ensureJobs([baseJob({ id: 'j' })]);
    await sched.tick();
    const job = sched.list()[0]!;
    expect(job.lastRun).toBeDefined();
    expect(job.nextRun).toBeDefined();
  });

  it('M36-1: byUser の予算設定は budgetSetByUser を立て、自律更新では立たない', () => {
    const sched = new GodScheduler(
      join(dir, 'schedule.json'),
      vi.fn(),
      { onBudgetAlert: () => {}, onJobRun: () => {} },
      () => new Date('2026-07-12T00:00:00'),
    );
    sched.ensureJobs([baseJob({ id: 'j' })]);
    // 神議の自律調整(byUserなし)ではフラグが立たない
    sched.update('j', { dailyTokenBudget: 5000 });
    expect(sched.list()[0]?.budgetSetByUser).toBeUndefined();
    // ユーザーの手動設定(引き上げも承認不要)でフラグが立つ
    sched.update('j', { dailyTokenBudget: 99_999 }, { byUser: true });
    const job = sched.list()[0]!;
    expect(job.dailyTokenBudget).toBe(99_999);
    expect(job.budgetSetByUser).toBe(true);
  });

  it('update: 間隔クランプ(ユーザー保護の下限を神議も越えられない)+永続化', () => {
    const sched = new GodScheduler(
      join(dir, 'schedule.json'),
      vi.fn(),
      { onBudgetAlert: () => {}, onJobRun: () => {} },
      () => new Date('2026-07-11T12:00:00'),
    );
    sched.ensureJobs([baseJob({ id: 'j' })]);
    const updated = sched.update('j', { intervalMin: 1 });
    expect(updated?.intervalMin).toBe(INTERVAL_MIN_FLOOR);
    // 再ロードで永続化確認
    const sched2 = new GodScheduler(
      join(dir, 'schedule.json'),
      vi.fn(),
      { onBudgetAlert: () => {}, onJobRun: () => {} },
    );
    expect(sched2.list()[0]?.intervalMin).toBe(INTERVAL_MIN_FLOOR);
  });
});

describe('M33-2: Inbox(受け箱)', () => {
  it('投函→未読一覧→既読化のフロー', () => {
    const inbox = new Inbox(dir);
    const item = inbox.post({ kind: 'metrics', godId: 'omoi-kami', title: 'スナップショット', payload: {} });
    inbox.post({ kind: 'triage', godId: 'tedika-rao', title: 'PR #1', payload: { number: 1 } });
    expect(inbox.unread()).toHaveLength(2);
    inbox.markRead([item.id]);
    expect(inbox.unread()).toHaveLength(1);
    expect(inbox.list()[1]?.read).toBe(true); // 新しい順なので古い方が既読
  });

  it('壊れた行はスキップして生き残る', () => {
    const inbox = new Inbox(dir);
    inbox.post({ kind: 'draft', godId: 'ameno-uzume', title: 'a', payload: {} });
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    appendFileSync(join(dir, 'inbox.jsonl'), 'ぐちゃぐちゃ\n', 'utf8');
    inbox.post({ kind: 'draft', godId: 'ameno-uzume', title: 'b', payload: {} });
    expect(inbox.list()).toHaveLength(2);
  });

  it('migrateLegacy: 既存の下書き・候補に受け箱エントリを作る(初回のみ・破棄分は除外)', () => {
    const inbox = new Inbox(dir);
    const drafts = [
      { id: 'd1', kind: 'x-post', title: 't', body: 'b', createdAt: '', status: 'draft' },
      { id: 'd2', kind: 'x-post', title: 't2', body: 'b', createdAt: '', status: 'discarded' },
    ] as never[];
    const candidates = [
      { id: 'c1', source: 's', profile: 'p', verdict: 'match', reasons: [], createdAt: '', status: 'new' },
    ] as never[];
    expect(inbox.migrateLegacy(drafts, candidates)).toBe(2);
    // 2回目は何もしない
    expect(inbox.migrateLegacy(drafts, candidates)).toBe(0);
    expect(inbox.list()).toHaveLength(2);
  });
});
