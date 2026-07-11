import { describe, expect, it } from 'vitest';
import {
  buildApprovalBatch,
  buildKamuhakariPrompt,
  classifyParamChange,
  parseKamuhakariOutput,
  reclassifyBudgetChange,
  type ParamChange,
} from './kamuhakari';
import { clampIntervalMin, INTERVAL_MIN_FLOOR } from './scheduler';

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
