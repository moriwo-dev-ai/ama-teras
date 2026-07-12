import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GodClockJob } from '../../shared/types';

/**
 * M33-1: 神々の時計(スケジューラ基盤)。
 * 鉄則: このスケジューラから外部発信への直通経路は無い — 神の実行は「観測・下書き・
 * 受け箱への投函」まで。execute系は必ず岩戸ゲート(protocol.ts)を通る。
 *
 * ジョブは2種類の時計を持つ:
 * - interval: N分ごと(神エージェント用)
 * - dailyTimes: 毎日決まった時刻(神議用。既定 09:00/21:00)
 *
 * 1日トークン予算: 超過を検知したら間隔を自動倍化(上限までクランプ)し、
 * 予算警告イベントを発火する(受け箱→神議への報告は呼び出し側が行う)。
 */

export type { GodClockJob };

/** 間隔クランプ(ユーザー設定の下限=これ未満に神議も自律調整もできない) */
export const INTERVAL_MIN_FLOOR = 15;
export const INTERVAL_MAX_CEIL = 24 * 60;

export function clampIntervalMin(min: number): number {
  return Math.min(INTERVAL_MAX_CEIL, Math.max(INTERVAL_MIN_FLOOR, Math.round(min)));
}

function dayKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** 次回実行時刻の計算(純関数) */
export function computeNextRun(job: GodClockJob, now: Date): Date {
  if (job.dailyTimes !== undefined && job.dailyTimes.length > 0) {
    // 今日の残り時刻のうち最も早いもの、無ければ明日の最初
    const candidates = job.dailyTimes
      .map((t) => {
        const [h, m] = t.split(':').map(Number);
        const d = new Date(now);
        d.setHours(h ?? 0, m ?? 0, 0, 0);
        return d;
      })
      .sort((a, b) => a.getTime() - b.getTime());
    for (const c of candidates) {
      if (c.getTime() > now.getTime()) return c;
    }
    const first = candidates[0] ?? new Date(now);
    const tomorrow = new Date(first);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow;
  }
  const base = job.lastRun !== undefined ? new Date(job.lastRun) : now;
  return new Date(base.getTime() + clampIntervalMin(job.intervalMin) * 60_000);
}

/** 実行すべきか(純関数) */
export function isDue(job: GodClockJob, now: Date): boolean {
  if (!job.enabled) return false;
  if (job.nextRun === undefined) return true; // 初回
  return new Date(job.nextRun).getTime() <= now.getTime();
}

/** 当日消費の加算(日付が変わっていればリセット)。純関数(新オブジェクトを返す) */
export function addSpent(job: GodClockJob, tokens: number, now: Date): GodClockJob {
  const key = dayKey(now);
  const spentToday = (job.spentDate === key ? job.spentToday : 0) + Math.max(0, tokens);
  return { ...job, spentToday, spentDate: key };
}

/** 予算超過か(0=無制限) */
export function isOverBudget(job: GodClockJob): boolean {
  return job.dailyTokenBudget > 0 && job.spentToday >= job.dailyTokenBudget;
}

/**
 * 予算超過時の自動間隔倍化(純関数)。dailyTimes 時計には適用しない(神議は回数固定)。
 * baseIntervalMin を保存し、翌日リセット時に復元できるようにする。
 */
export function widenIntervalForBudget(job: GodClockJob): GodClockJob {
  if (job.dailyTimes !== undefined) return job;
  const base = job.baseIntervalMin ?? job.intervalMin;
  return {
    ...job,
    baseIntervalMin: base,
    intervalMin: clampIntervalMin(job.intervalMin * 2),
  };
}

/** 日付が変わったら倍化間隔を基準に戻す(純関数) */
export function restoreIntervalIfNewDay(job: GodClockJob, now: Date): GodClockJob {
  if (job.spentDate === undefined || job.spentDate === dayKey(now)) return job;
  const restored: GodClockJob = { ...job, spentToday: 0, spentDate: dayKey(now) };
  if (job.baseIntervalMin !== undefined) {
    restored.intervalMin = job.baseIntervalMin;
    delete restored.baseIntervalMin;
  }
  return restored;
}

export interface SchedulerEvents {
  onBudgetAlert: (job: GodClockJob) => void;
  onJobRun: (job: GodClockJob, result: { ok: boolean; detail: string; tokensUsed: number }) => void;
}

export type GodRunner = (godId: string) => Promise<{ ok: boolean; detail: string; tokensUsed: number }>;

/**
 * スケジューラ本体。tick(1分)ごとに期限のジョブを直列実行する
 * (神々は少数なので並列不要。直列の方がAPIレートにも優しい)。
 * 起動時の追いつき: 期限超過ジョブは1回分だけ実行(catchUpDelayMs 後に開始し、
 * 起動直後の負荷集中を避ける)。
 */
export class GodScheduler {
  private jobs: GodClockJob[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * M41-1: 起動待ち(catchUp)のタイマー。stop() でこれを止めていなかったため、
   * 停止したはずのスケジューラが90秒後に息を吹き返して setInterval を張り、
   * 設定保存(reset→再init)のたびに幽霊スケジューラが増殖していた
   * (神議が数十秒間に連続実行され、古いメモリ状態が schedule.json を上書きした)
   */
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private running = false;

  constructor(
    private readonly filePath: string,
    private readonly runner: GodRunner,
    private readonly events: SchedulerEvents,
    private readonly nowFn: () => Date = () => new Date(),
  ) {
    this.load();
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(parsed)) this.jobs = parsed as GodClockJob[];
    } catch {
      this.jobs = [];
    }
  }

  private save(): void {
    // M41-1: 停止済みスケジューラは書かない。古いメモリ上のジョブで現行の
    // schedule.json を上書きする事故(状態の巻き戻し)を構造的に防ぐ
    if (this.stopped) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.jobs, null, 1), 'utf8');
    } catch {
      // 保存失敗でスケジューラを止めない
    }
  }

  /** 既定ジョブの登録(既存があれば時計・状態を維持し、無いものだけ追加) */
  ensureJobs(defaults: GodClockJob[]): void {
    for (const def of defaults) {
      if (!this.jobs.some((j) => j.id === def.id)) this.jobs.push({ ...def });
    }
    // 定義から消えたジョブは無効化(削除はしない=履歴保持)
    this.save();
  }

  list(): GodClockJob[] {
    return this.jobs.map((j) => ({ ...j }));
  }

  /**
   * 神議の自律調整/ユーザー操作の入口。間隔はクランプ、dailyTimesはHH:MM形式のみ。
   * M36-1: byUser=true(ユーザーの直接設定・人間承認済みの変更)による予算設定は
   * budgetSetByUser を立て、以後の神議の自律予算調整(引き下げ含む)より優先される
   * (自律側の拒否は manager.applyAutonomousChange が担う)
   */
  update(
    id: string,
    patch: Partial<
      Pick<GodClockJob, 'intervalMin' | 'enabled' | 'dailyTimes' | 'dailyTokenBudget' | 'budgetSetByUser'>
    >,
    opts: { byUser?: boolean } = {},
  ): GodClockJob | null {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return null;
    // M38-1: 予算のロック解錠(🔓)。ユーザーが明示的に神議へ調整権限を返す操作。
    // 施錠(true)は予算設定と同時にしか起きない(下の byUser 経路)ので、ここでは解錠のみ扱う
    if (patch.budgetSetByUser === false) {
      job.budgetSetByUser = undefined as never;
      delete job.budgetSetByUser;
    }
    if (patch.intervalMin !== undefined) {
      job.intervalMin = clampIntervalMin(patch.intervalMin);
      job.baseIntervalMin = undefined as never;
      delete job.baseIntervalMin;
    }
    if (patch.enabled !== undefined) job.enabled = patch.enabled;
    if (patch.dailyTimes !== undefined) {
      const valid = patch.dailyTimes.filter((t) => /^\d{2}:\d{2}$/.test(t));
      if (valid.length > 0) job.dailyTimes = valid;
    }
    if (patch.dailyTokenBudget !== undefined && patch.dailyTokenBudget >= 0) {
      job.dailyTokenBudget = Math.round(patch.dailyTokenBudget);
      if (opts.byUser === true) job.budgetSetByUser = true;
    }
    job.nextRun = computeNextRun(job, this.nowFn()).toISOString();
    this.save();
    return { ...job };
  }

  /** 開始。catchUpDelayMs 後に初回tick(起動直後の負荷集中回避) */
  start(tickMs = 60_000, catchUpDelayMs = 90_000): void {
    if (this.timer !== null || this.startTimer !== null || this.stopped) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.stopped) return; // stop() 済みなら復活させない
      void this.tick();
      this.timer = setInterval(() => void this.tick(), tickMs);
    }, catchUpDelayMs);
  }

  /** 停止。以後 start() しても復活しない(使い捨て=幽霊スケジューラを作らない) */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  /** 1周期分の実行(テストから直接呼べる) */
  async tick(): Promise<void> {
    if (this.stopped) return; // M41-1: 停止後のtickは走らせない
    if (this.running) return; // 再入防止(長いジョブ中のtick重複)
    this.running = true;
    try {
      const now = this.nowFn();
      for (let i = 0; i < this.jobs.length; i++) {
        let job = this.jobs[i]!;
        job = restoreIntervalIfNewDay(job, now);
        this.jobs[i] = job;
        if (!isDue(job, now)) continue;
        if (isOverBudget(job)) {
          // 予算超過中は実行せず翌日を待つ(間隔は超過検知時に倍化済み)
          job.nextRun = computeNextRun(job, now).toISOString();
          continue;
        }
        let result: { ok: boolean; detail: string; tokensUsed: number };
        try {
          result = await this.runner(job.godId);
        } catch (err) {
          result = { ok: false, detail: err instanceof Error ? err.message : String(err), tokensUsed: 0 };
        }
        let updated = addSpent(job, result.tokensUsed, now);
        updated.lastRun = now.toISOString();
        if (isOverBudget(updated)) {
          updated = widenIntervalForBudget(updated);
          this.events.onBudgetAlert(updated);
        }
        updated.nextRun = computeNextRun({ ...updated, lastRun: now.toISOString() }, now).toISOString();
        this.jobs[i] = updated;
        this.events.onJobRun(updated, result);
        this.save();
      }
      this.save();
    } finally {
      this.running = false;
    }
  }
}
