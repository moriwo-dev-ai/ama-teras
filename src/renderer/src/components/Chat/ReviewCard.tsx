import { useState } from 'react';
import type { ReviewCardPayload } from '../../../../shared/types';

/**
 * M19: 品質レビューの採点カード。4軸スコア+具体指摘を表示する。
 * 合格=緑 / 不合格=琥珀 / 上限到達の未解決=赤。
 */

const AXIS_LABEL: Record<string, string> = {
  code: 'コード品質',
  ux: '見た目/UX',
  requirements: '要件達成',
  tests: 'テストの質',
};

/** M26-1: severityバッジ(high=赤/medium=琥珀/low=グレー)。ライトテーマ上書き済みのクラスのみ使用 */
const SEVERITY_BADGE: Record<string, { label: string; cls: string }> = {
  high: { label: 'high', cls: 'bg-red-900 text-red-200' },
  medium: { label: 'medium', cls: 'bg-amber-900 text-amber-200' },
  low: { label: 'low', cls: 'bg-zinc-700 text-zinc-300' },
};

export function ReviewCard({ card }: { card: ReviewCardPayload }): JSX.Element {
  const [open, setOpen] = useState(!card.pass);
  const tone = card.unresolved
    ? 'border-red-700 bg-red-950/60'
    : card.pass
      ? 'border-emerald-700 bg-emerald-950/40'
      : 'border-amber-700 bg-amber-950/40';
  const badge = card.unresolved
    ? '🔴 残課題あり'
    : card.pass
      ? '✅ 合格'
      : '🔶 不合格 → 差し戻し';

  return (
    <div className="anim-appear flex justify-center">
      <div className={`w-full max-w-[85%] rounded-md border px-3 py-2 text-xs ${tone}`}>
        <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((v) => !v)}>
          <span className="font-semibold text-zinc-200">
            🧪 品質レビュー{card.round > 0 ? `(再レビュー${card.round}回目)` : ''}
          </span>
          <span>{badge}</span>
          <span className="font-mono text-zinc-300">{card.average.toFixed(1)}/5</span>
          <span className="ml-auto truncate text-zinc-500" title={card.milestone}>
            {card.milestone}
          </span>
          <span className="text-zinc-500">{open ? '▲' : '▼'}</span>
        </button>
        {open && (
          <div className="mt-1.5 space-y-1.5 border-t border-zinc-700/60 pt-1.5">
            <div className="flex flex-wrap gap-2">
              {(Object.keys(AXIS_LABEL) as (keyof ReviewCardPayload['scores'])[]).map((axis) => {
                const v = card.scores[axis];
                return (
                  <span key={axis} className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-zinc-300">
                    {AXIS_LABEL[axis]}: {v === null ? '—' : `${v}/5`}
                  </span>
                );
              })}
            </div>
            {card.summary && <p className="text-zinc-300">{card.summary}</p>}
            {card.findings.length > 0 && (
              <ul className="space-y-1">
                {card.findings.map((f, i) => {
                  // 旧データ(severity無し)は medium 表示に倒す
                  const sev = SEVERITY_BADGE[f.severity] ?? SEVERITY_BADGE['medium']!;
                  return (
                  <li key={i} className="rounded border border-zinc-700/60 bg-zinc-900/60 px-2 py-1">
                    <span className={`mr-1.5 rounded px-1 py-0.5 text-[10px] font-semibold ${sev.cls}`}>
                      {sev.label}
                    </span>
                    <span className="font-mono text-blue-300">{f.file}</span>
                    <span className="text-zinc-500">({f.location})</span>
                    <div className="text-zinc-300">問題: {f.problem}</div>
                    <div className="text-emerald-300/90">修正: {f.fix}</div>
                  </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
