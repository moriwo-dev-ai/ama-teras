import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateOpsCost, runsPerDay } from '../../shared/opsCost';
import type { GodClockJob as Job, ProjectProfile } from '../../shared/types';
import { buildXSearchSuggestions } from './adapters/x';
import { articleSlug, ZENN_SLUG_RE } from './adapters/zennRepo';
import { buildArticleOutlinePrompt, buildHighlightPrompt } from './amenoUzume';
import { buildKamuhakariPrompt } from './kamuhakari';
import { GodScheduler, type GodClockJob } from './scheduler';
import { buildTriagePrompt } from './tedikaRao';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm41-'));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const baseJob = (over: Partial<GodClockJob> = {}): GodClockJob => ({
  id: 'j1',
  godId: 'kamuhakari',
  intervalMin: 60,
  enabled: true,
  dailyTokenBudget: 0,
  spentToday: 0,
  ...over,
});

describe('M41-1: 幽霊スケジューラの根絶(神議の多重実行・状態の巻き戻し)', () => {
  const make = (runner = vi.fn().mockResolvedValue({ ok: true, detail: '', tokensUsed: 0 })): { sched: GodScheduler; runner: ReturnType<typeof vi.fn> } => {
    const sched = new GodScheduler(
      join(dir, 'schedule.json'),
      runner,
      { onBudgetAlert: () => {}, onJobRun: () => {} },
      () => new Date('2026-07-12T12:00:00'),
    );
    sched.ensureJobs([baseJob()]);
    return { sched, runner };
  };

  it('stop() は起動待ちタイマーも止める: 停止後に復活してtickしない(90秒後の蘇生バグ)', async () => {
    const { sched, runner } = make();
    sched.start(60_000, 90_000);
    sched.stop(); // 起動待ち(90秒)の最中に停止
    await vi.advanceTimersByTimeAsync(200_000);
    expect(runner).not.toHaveBeenCalled(); // 以前はここで蘇って走り続けていた
  });

  it('停止後に start() しても復活しない(使い捨て。設定保存のたびに幽霊が増えない)', async () => {
    const { sched, runner } = make();
    sched.stop();
    sched.start(60_000, 1_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner).not.toHaveBeenCalled();
  });

  it('停止済みスケジューラは schedule.json を書かない(古い状態での巻き戻しを防ぐ)', () => {
    const path = join(dir, 'schedule.json');
    const { sched } = make();
    sched.update('j1', { dailyTokenBudget: 12345 }, { byUser: true });
    expect(readFileSync(path, 'utf8')).toContain('12345');

    // 現行スケジューラ(別インスタンス)がユーザー設定を書いたあと…
    const live = new GodScheduler(path, vi.fn(), { onBudgetAlert: () => {}, onJobRun: () => {} });
    live.update('j1', { dailyTokenBudget: 99999 }, { byUser: true });

    // 停止済みの古いスケジューラが何をしても、ファイルは上書きされない
    sched.stop();
    sched.update('j1', { dailyTokenBudget: 1 });
    expect(readFileSync(path, 'utf8')).toContain('99999');
    expect(readFileSync(path, 'utf8')).not.toContain('"dailyTokenBudget": 1\n');
  });

  it('二重 start() でもタイマーは1本(1周期で1回だけ走る)', async () => {
    const { sched, runner } = make();
    sched.start(60_000, 1_000);
    sched.start(60_000, 1_000);
    sched.start(60_000, 1_000);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(runner).toHaveBeenCalledTimes(1);
    sched.stop();
  });
});

describe('M41-3: 一般ユーザー向け汎用化(プロジェクト名のハードコード排除)', () => {
  const project: ProjectProfile = { name: 'my-tool', description: '個人開発のCLIツール' };

  it('広報・記事・神議・トリアージのプロンプトに設定のプロジェクト名が入る(AMA-terasは出ない)', () => {
    const highlight = buildHighlightPrompt({
      progressExcerpt: '',
      recentCommits: '',
      current: null,
      previous: null,
      project,
    });
    const article = buildArticleOutlinePrompt({ title: 't', outline: 'o', progressExcerpt: '', project });
    const kamu = buildKamuhakariPrompt({
      unread: [],
      history: [],
      postedDrafts: [],
      jobs: [],
      currentKeywords: [],
      project,
    });
    const triage = buildTriagePrompt(
      { number: 1, title: 't', author: 'a', kind: 'issue', body: 'b', labels: [], createdAt: '' },
      null,
      project,
    );
    for (const p of [highlight, article, kamu, triage]) {
      expect(p).toContain('my-tool');
      expect(p).not.toContain('AMA-teras');
    }
    expect(highlight).toContain('個人開発のCLIツール');
  });

  it('X検索: プロジェクト名未設定なら言及検索を出さない(他人の名前を検索しない)', () => {
    const withName = buildXSearchSuggestions(['自作エージェント'], 'my-tool');
    expect(withName.some((s) => s.label.includes('my-tool'))).toBe(true);
    const without = buildXSearchSuggestions(['自作エージェント']);
    expect(without.every((s) => !s.query.includes('AMA-teras'))).toBe(true);
    expect(without).toHaveLength(2); // キーワード由来の2件のみ
  });

  it('Zennのslug: 日本語タイトルのフォールバック接頭辞もプロジェクト名から', () => {
    const slug = articleSlug('自己進化エージェントの作り方', '202607121530', 'my-tool');
    expect(slug).toBe('my-tool-202607121530');
    expect(slug).toMatch(ZENN_SLUG_RE);
    // 記号だらけの名前でもZenn規則を満たす
    expect(articleSlug('日本語', '202607121530', '★★★')).toMatch(ZENN_SLUG_RE);
  });
});

describe('M41-4: 想定コストの概算(表示のみ・既定は変えない)', () => {
  const job = (over: Partial<Job>): Job => ({
    id: 'x',
    godId: 'kamuhakari',
    intervalMin: 720,
    enabled: true,
    dailyTokenBudget: 0,
    spentToday: 0,
    ...over,
  });

  it('実行回数: dailyTimes優先、無ければ間隔から。停止中は0', () => {
    expect(runsPerDay(job({ dailyTimes: ['09:00', '21:00'] }))).toBe(2);
    expect(runsPerDay(job({ intervalMin: 60 }))).toBe(24);
    expect(runsPerDay(job({ enabled: false }))).toBe(0);
  });

  it('予算があればそれで頭打ち。観測神(LLM不使用)は0', () => {
    const est = estimateOpsCost(
      [
        job({ godId: 'kamuhakari', dailyTimes: ['09:00', '21:00'] }),
        job({ godId: 'omoi-kami', intervalMin: 360 }),
        job({ godId: 'uzume-patrol', intervalMin: 60, dailyTokenBudget: 30_000 }),
      ],
      {
        kamuhakari: { provider: 'anthropic', model: 'claude-sonnet-5' },
        gods: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      },
    );
    expect(est.perGod.find((g) => g.godId === 'omoi-kami')?.tokens).toBe(0); // 観測はLLMを使わない
    expect(est.perGod.find((g) => g.godId === 'uzume-patrol')?.tokens).toBe(30_000); // 予算で頭打ち
    expect(est.dailyUsd).not.toBeNull();
    expect(est.monthlyUsd).toBeCloseTo((est.dailyUsd ?? 0) * 30, 5);
  });

  it('単価不明のモデル(ローカル等)では金額を出さない(嘘の数字を出さない)', () => {
    const est = estimateOpsCost([job({ godId: 'kamuhakari', dailyTimes: ['09:00'] })], {
      kamuhakari: { provider: 'openai', model: 'llama3-local' },
      gods: { provider: 'openai', model: 'llama3-local' },
    });
    expect(est.dailyTokens).toBeGreaterThan(0);
    expect(est.dailyUsd).toBeNull();
    expect(est.monthlyUsd).toBeNull();
  });
});
