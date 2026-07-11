import type { ImpactEntry, MetricsSnapshot, MetricTotals, OperationsDraft } from '../../shared/types';

/**
 * M38-3: 発信の効果測定(投稿 → 前後メトリクス差分)。
 *
 * 神議が能力ギャップ(evolve)として要求した機能:
 * 「どの投稿(URL/日時)がどのタイミングで★やDLの変化を生んだか紐付けできていない。
 *  効果測定なしに施策のPDCAが回せない」(承認バッチ 2026-07-11)
 *
 * 投稿済みドラフト(postedAt)の直前スナップショットと、計測窓(既定24h)経過後の
 * 最初のスナップショットを突き合わせて差分を出す。純関数=テストで固定できる。
 * 注意: 相関であって因果ではない(同時期の他要因を排除できない)。UIでもそう表示する。
 */

export type { ImpactEntry, MetricTotals };

const ZERO: MetricTotals = {
  stars: 0,
  zennLiked: 0,
  zennComments: 0,
  hatena: 0,
  downloads: 0,
  views: 0,
};

/** スナップショット → 合計値(リポジトリ・記事をまたいだ総量) */
export function totals(snap: MetricsSnapshot): MetricTotals {
  const gh = Object.values(snap.github);
  const zenn = Object.values(snap.zenn);
  return {
    stars: gh.reduce((a, m) => a + m.stars, 0),
    zennLiked: zenn.reduce((a, m) => a + m.liked, 0),
    zennComments: zenn.reduce((a, m) => a + m.comments, 0),
    hatena: Object.values(snap.hatena ?? {}).reduce((a, c) => a + c, 0),
    downloads: gh.reduce((a, m) => a + (m.downloads ?? 0), 0),
    views: gh.reduce((a, m) => a + (m.views ?? 0), 0),
  };
}

function diff(before: MetricTotals, after: MetricTotals): MetricTotals {
  const keys = Object.keys(ZERO) as (keyof MetricTotals)[];
  const out = { ...ZERO };
  for (const k of keys) out[k] = after[k] - before[k];
  return out;
}

/** 本文から最初のURL(はてブ/効果測定で「どの投稿か」を人間が辿るための手掛かり) */
export function firstUrlIn(text: string): string | null {
  const m = /https?:\/\/[^\s<>"')\]}、。]+/.exec(text);
  return m ? m[0] : null;
}

/** 差分が全て0か(=「効果が出ていない」を正直に言うための判定) */
export function isFlat(delta: MetricTotals): boolean {
  return (Object.keys(ZERO) as (keyof MetricTotals)[]).every((k) => delta[k] === 0);
}

/** 人間が読む1行サマリ */
export function summarize(entry: ImpactEntry): string {
  if (!entry.measurable || entry.delta === null) return `${entry.title}: ${entry.note}`;
  const d = entry.delta;
  if (isFlat(d)) return `${entry.title}: 計測窓${entry.windowHours}hで変化なし(±0)`;
  const parts: string[] = [];
  const push = (label: string, v: number): void => {
    if (v !== 0) parts.push(`${label}${v > 0 ? '+' : ''}${v}`);
  };
  push('★', d.stars);
  push('Zenn♥', d.zennLiked);
  push('💬', d.zennComments);
  push('B!', d.hatena);
  push('DL', d.downloads);
  push('閲覧', d.views);
  return `${entry.title}: ${parts.join(' / ')}(投稿後${entry.windowHours}h)`;
}

/**
 * 投稿済みドラフト × メトリクス時系列 → 前後差分。
 * before = postedAt 以前で最も新しいスナップショット
 * after  = postedAt + windowHours 以降で最も古いスナップショット
 */
export function computeImpacts(
  posted: OperationsDraft[],
  history: MetricsSnapshot[],
  now: Date,
  windowHours = 24,
): ImpactEntry[] {
  const snaps = [...history].sort((a, b) => a.ts.localeCompare(b.ts));
  const entries: ImpactEntry[] = [];

  for (const draft of posted) {
    if (draft.postedAt === undefined) continue;
    const postedMs = Date.parse(draft.postedAt);
    if (Number.isNaN(postedMs)) continue;
    const windowEnd = postedMs + windowHours * 3600_000;

    const base: Omit<ImpactEntry, 'measurable' | 'before' | 'after' | 'delta' | 'note'> = {
      draftId: draft.id,
      title: draft.title,
      media: draft.media ?? null,
      url: firstUrlIn(draft.body),
      postedAt: draft.postedAt,
      windowHours,
    };

    const before = [...snaps].reverse().find((s) => Date.parse(s.ts) <= postedMs) ?? null;
    const after = snaps.find((s) => Date.parse(s.ts) >= windowEnd) ?? null;

    if (before === null) {
      entries.push({
        ...base,
        measurable: false,
        before: null,
        after: null,
        delta: null,
        note: '投稿前のスナップショットが無い(観測神が止まっていた期間の投稿)',
      });
      continue;
    }
    if (after === null) {
      entries.push({
        ...base,
        measurable: false,
        before: totals(before),
        after: null,
        delta: null,
        note:
          now.getTime() < windowEnd
            ? `計測中(あと${Math.max(1, Math.ceil((windowEnd - now.getTime()) / 3600_000))}時間)`
            : '計測窓は過ぎたが観測スナップショットが無い(観測神が停止している可能性)',
      });
      continue;
    }
    const b = totals(before);
    const a = totals(after);
    entries.push({ ...base, measurable: true, before: b, after: a, delta: diff(b, a), note: '' });
  }

  // 新しい投稿が上
  return entries.sort((x, y) => y.postedAt.localeCompare(x.postedAt));
}
