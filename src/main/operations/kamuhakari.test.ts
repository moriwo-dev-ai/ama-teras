import { describe, expect, it } from 'vitest';
import {
  buildApprovalBatch,
  buildKamuhakariPrompt,
  classifyParamChange,
  buildThreadContext,
  formatMetricsSeries,
  formatPublishState,
  parseThreadAction,
  parseKamuhakariOutput,
  reclassifyBudgetChange,
  type ParamChange,
} from './kamuhakari';
import { clampIntervalMin, INTERVAL_MIN_FLOOR } from './scheduler';
import type { GodClockJob, MetricsSnapshot } from '../../shared/types';

/**
 * M33-4: 神議の2段階制をテストで固定する(NIGHT_TASKS7 T4)。
 * - 自律可: interval / keywords / pause / resume / tool-toggle / rate-limit / budget-decrease
 * - 承認必須: new-tool / judge-prompt / budget-increase / god-create / god-delete
 * - ユーザー設定の上限(間隔の下限・予算の天井)を神議は越えられない
 */

const change = (kind: ParamChange['kind'], value?: unknown): ParamChange => ({
  kind,
  godId: 'ameno-uzume',
  reason: 'test',
  value,
});

describe('M33-4: 2段階制の分類', () => {
  it('自律で変更可能な種類', () => {
    for (const kind of ['interval', 'keywords', 'pause', 'resume', 'tool-toggle', 'rate-limit', 'budget-decrease'] as const) {
      expect(classifyParamChange(change(kind)), kind).toBe('autonomous');
    }
  });

  it('人間承認が必須な種類(組織図の自己改変は最厳格)', () => {
    for (const kind of ['new-tool', 'judge-prompt', 'budget-increase', 'god-create', 'god-delete'] as const) {
      expect(classifyParamChange(change(kind)), kind).toBe('approval');
    }
  });

  it('予算変更は宣言でなく実際の値で再分類(騙り増額の防止)', () => {
    // 「引き下げ」と宣言しつつ実際は増額 → 承認必須へ矯正
    expect(reclassifyBudgetChange(change('budget-decrease', 20_000), 10_000).kind).toBe('budget-increase');
    // 正しい引き下げは自律のまま
    expect(reclassifyBudgetChange(change('budget-decrease', 5_000), 10_000).kind).toBe('budget-decrease');
    // 「引き上げ」宣言で実際は減額 → 自律扱いに緩和(値が正)
    expect(reclassifyBudgetChange(change('budget-increase', 5_000), 10_000).kind).toBe('budget-decrease');
    // 不正値は安全側=承認必須
    expect(reclassifyBudgetChange(change('budget-decrease', 'ぜんぶ'), 10_000).kind).toBe('budget-increase');
    expect(reclassifyBudgetChange(change('budget-decrease', -1), 10_000).kind).toBe('budget-increase');
  });

  it('間隔はユーザー保護の下限を越えられない(クランプはscheduler側で強制)', () => {
    expect(clampIntervalMin(0)).toBe(INTERVAL_MIN_FLOOR);
    expect(clampIntervalMin(-100)).toBe(INTERVAL_MIN_FLOOR);
  });
});

describe('M64: 公開状態の一次情報', () => {
  it('公開済み/未公開を実測どおりに書き分け、取得できなかったものは隠さない', () => {
    const text = formatPublishState({
      releases: [
        { repo: 'o/r', tag: 'v1.1.0', draft: false },
        { repo: 'o/r', tag: 'v1.2.0', draft: true },
      ],
      zennArticles: [
        { slug: 'live-one', published: true },
        { slug: 'hidden-one', published: false },
      ],
      unavailable: ['x のことは分からない'],
    });
    expect(text).toContain('v1.1.0: 公開済み');
    expect(text).toContain('v1.2.0: **draft');
    expect(text).toContain('live-one: 公開済み');
    expect(text).toContain('hidden-one: **published: false');
    expect(text).toContain('x のことは分からない');
  });

  it('一次情報が無いときは「取得していない」と明示する(推測させない)', () => {
    expect(formatPublishState(undefined)).toContain('断定しないこと');
  });

  it('プロンプトに実状態が載り、「draftで作られる」という一般論は載らない', () => {
    const prompt = buildKamuhakariPrompt({
      unread: [],
      history: [],
      postedDrafts: [],
      jobs: [],
      currentKeywords: [],
      project: { name: 'p', description: 'd' },
      publishState: { releases: [{ repo: 'o/r', tag: 'v1.1.0', draft: false }], zennArticles: [], unavailable: [] },
    });
    expect(prompt).toContain('v1.1.0: 公開済み');
    expect(prompt).not.toContain('GitHub Release は draft で作られる');
  });
});

describe('M33-4: 神議の入出力', () => {
  it('プロンプトに受け箱・時系列・投下履歴・時計・権限(2段階制)が含まれる', () => {
    const prompt = buildKamuhakariPrompt({
      unread: [
        { id: '1', kind: 'metrics', ts: '', godId: 'omoi-kami', title: 'snap', payload: {} },
        { id: '2', kind: 'candidate', ts: '', godId: 'ameno-uzume', title: '候補: @alice', payload: {} },
      ],
      history: [
        { ts: '2026-07-11T15:00:00Z', github: { 'o/r': { stars: 3, forks: 0, watchers: 0, openIssues: 0, openPRs: 0 } }, zenn: { s: { liked: 5, comments: 1 } } },
      ],
      postedDrafts: [
        { id: 'd', kind: 'x-post', title: 'Zenn記事投稿', body: '', createdAt: '', status: 'posted', postedAt: '2026-07-11', media: 'x' },
      ],
      jobs: [
        { id: 'j', godId: 'ameno-uzume', intervalMin: 60, enabled: true, dailyTokenBudget: 10000, spentToday: 500 },
      ],
      currentKeywords: ['AIエージェント'],
      project: { name: 'テスト製品', description: 'テスト用の説明' },
    });
    expect(prompt).toContain('候補: @alice');
    expect(prompt).toContain('★3');
    expect(prompt).toContain('Zenn記事投稿');
    expect(prompt).toContain('間隔60分');
    expect(prompt).toContain('人間承認必須');
    expect(prompt).toContain('岩戸');
  });

  it('parseKamuhakariOutput: 正常系+壊れた出力はnull', () => {
    const ok = parseKamuhakariOutput(
      JSON.stringify({
        analysis: 'Zenn流入が主。',
        paramChanges: [{ kind: 'keywords', godId: 'ameno-uzume', reason: '拡げる', value: ['自作LLM'] }],
        proposals: [{ kind: 'exec-action', title: 'はてブ', detail: 'セルフブクマ' }],
      }),
    );
    expect(ok?.analysis).toContain('Zenn');
    expect(ok?.paramChanges[0]?.kind).toBe('keywords');
    expect(ok?.proposals[0]?.kind).toBe('exec-action');
    expect(parseKamuhakariOutput('こんばんは')).toBeNull();
  });

  it('M33-6: 能力ギャップの3分岐がパース・バッチに保持される(不明branchはadhocへ安全側)', () => {
    const parsed = parseKamuhakariOutput(
      JSON.stringify({
        analysis: 'a',
        paramChanges: [],
        proposals: [
          { kind: 'capability-gap', title: '英語圏巡回が欲しい', detail: '…', branch: 'new-god', godDraft: { id: 'uzume-en' } },
          { kind: 'capability-gap', title: 'HN観測', detail: '…', branch: 'evolve' },
          { kind: 'capability-gap', title: '謎', detail: '…', branch: 'take-over-the-world' },
        ],
      }),
    );
    expect(parsed?.proposals[0]?.gap).toEqual({ branch: 'new-god', godDraft: { id: 'uzume-en' } });
    expect(parsed?.proposals[1]?.gap?.branch).toBe('evolve');
    expect(parsed?.proposals[2]?.gap?.branch).toBe('adhoc'); // 安全側
    const batch = buildApprovalBatch('a', [], parsed?.proposals ?? []);
    expect(batch?.items[0]?.gap?.branch).toBe('new-god');
  });

  it('承認バッチ: 承認必須の変更+提案が項目化され、空なら null', () => {
    const batch = buildApprovalBatch(
      '分析',
      [change('budget-increase', 50_000)],
      [{ kind: 'capability-gap', title: 'HN観測が欲しい', detail: 'read専用アダプタ' }],
    );
    expect(batch?.items).toHaveLength(2);
    expect(batch?.items.every((i) => i.status === 'pending')).toBe(true);
    expect(buildApprovalBatch('分析だけ', [], [])).toBeNull();
  });
});

/**
 * M99-11: 運営チャットの知識と操作。
 * チャットが「クローン数の時系列データは未取得」と誤答した実害
 * (勘違いではなく、プロンプトに時系列を渡していなかった)を塞ぐ。
 */
describe('M99-11: メトリクス時系列と運営チャットの文脈', () => {
  const snap = (ts: string, clones: number, unique: number): MetricsSnapshot =>
    ({
      ts,
      github: { 'o/ama-teras': { stars: 0, forks: 0, views: 69, clones, clonesUnique: unique, downloads: 10 } },
      zenn: {},
    }) as unknown as MetricsSnapshot;

  it('時系列に clone(u付き)が入る — 神議とチャットの両方が推移を語れる', () => {
    const s = formatMetricsSeries([snap('2026-07-21T06:58:00Z', 544, 213), snap('2026-07-22T06:59:00Z', 554, 216)]);
    expect(s).toContain('clone544(u213)');
    expect(s).toContain('clone554(u216)');
  });

  it('buildThreadContext は時系列・時計・下書き・公開状態を含む', () => {
    const ctx = buildThreadContext({
      history: [snap('2026-07-22T06:59:00Z', 554, 216)],
      jobs: [
        { id: 'j1', godId: 'uzume-drafts', enabled: true, intervalMin: 1440, dailyTokenBudget: 20000, spentToday: 0 },
      ] as unknown as GodClockJob[],
      postedDrafts: [],
      stagedDrafts: [],
      activeDraftTitles: ['進化・公開フローの安全性と復旧性を改善'],
      evolutionJobs: [],
    });
    expect(ctx).toContain('clone554(u216)');
    expect(ctx).toContain('uzume-drafts');
    expect(ctx).toContain('進化・公開フローの安全性と復旧性を改善');
    expect(ctx).toContain('公開状態の一次情報');
  });
});

describe('M99-11: チャット返信のアクション解析', () => {
  it('run-god を取り出し、表示本文からタグを除く', () => {
    const { body, action } = parseThreadAction(
      'リリースノートの下書きを生成します。\n<action>{"kind":"run-god","godId":"uzume-drafts"}</action>',
    );
    expect(action).toEqual({ kind: 'run-god', godId: 'uzume-drafts' });
    expect(body).toBe('リリースノートの下書きを生成します。');
    expect(body).not.toContain('<action>');
  });

  it('アクション無し・壊れたJSON・未知kindは本文だけ返す(チャットを壊さない)', () => {
    expect(parseThreadAction('ただの返事')).toEqual({ body: 'ただの返事', action: null });
    expect(parseThreadAction('x <action>{壊れてる}</action>').action).toBeNull();
    expect(parseThreadAction('x <action>{"kind":"rm-rf","godId":"a"}</action>').action).toBeNull();
    // 本文は残る
    expect(parseThreadAction('x <action>{壊れてる}</action>').body).toBe('x');
  });
});
