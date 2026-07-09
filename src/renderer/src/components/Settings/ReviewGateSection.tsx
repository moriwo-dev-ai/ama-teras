import type { AppConfig, ReviewGateConfig } from '../../../../shared/types';

/**
 * M19: 「品質レビュー」節。マイルストーンごとに planner 帯が4軸採点し、
 * 閾値未満なら worker へ差し戻す。既定は無効(ONでコスト増のためUIに注記)。
 */

const DEFAULT_GATE: ReviewGateConfig = {
  enabled: true,
  passMode: 'severity',
  threshold: 4.0,
  maxRoundsPerMilestone: 2,
  axes: { code: true, ux: true, requirements: true, tests: true },
};

const PRESETS: { label: string; threshold: number; rounds: number }[] = [
  { label: 'しっかり(4.5 / 3周)', threshold: 4.5, rounds: 3 },
  { label: '標準(4.0 / 2周)', threshold: 4.0, rounds: 2 },
  { label: '軽め(3.5 / 1周)', threshold: 3.5, rounds: 1 },
];

const AXIS_LABEL: Record<keyof ReviewGateConfig['axes'], string> = {
  code: 'コード品質',
  ux: '見た目/UX(screenshot)',
  requirements: '要件達成',
  tests: 'テストの質',
};

export function ReviewGateSection({
  config,
  onSave,
}: {
  config: AppConfig;
  onSave: (next: AppConfig) => void;
}): JSX.Element {
  const gate = config.reviewGate;
  const enabled = gate?.enabled === true;

  const save = (next: ReviewGateConfig): void => {
    onSave({ ...config, reviewGate: next });
  };

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            if (e.target.checked) save({ ...(gate ?? DEFAULT_GATE), enabled: true });
            else if (gate) save({ ...gate, enabled: false });
          }}
        />
        品質レビュー(マイルストーンごとにplannerが採点→差し戻し)
      </label>
      {enabled && gate && (
        <div className="space-y-2 rounded border border-zinc-700 bg-zinc-950/50 p-2 text-xs">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className="rounded border border-zinc-600 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
                onClick={() => save({ ...gate, threshold: p.threshold, maxRoundsPerMilestone: p.rounds })}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="w-40 shrink-0 text-zinc-400">合格判定方式</span>
            <label className="flex items-center gap-1 text-zinc-300">
              <input
                type="radio"
                name="review-pass-mode"
                checked={(gate.passMode ?? 'severity') === 'severity'}
                onChange={() => save({ ...gate, passMode: 'severity' })}
              />
              severity方式(high指摘ゼロで合格・推奨)
            </label>
            <label className="flex items-center gap-1 text-zinc-300">
              <input
                type="radio"
                name="review-pass-mode"
                checked={gate.passMode === 'score'}
                onChange={() => save({ ...gate, passMode: 'score' })}
              />
              スコア方式(平均閾値・従来)
            </label>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-40 shrink-0 text-zinc-400">
              合格閾値(1〜5){(gate.passMode ?? 'severity') === 'severity' ? '※表示用' : ''}
            </span>
            <select
              className="rounded border border-zinc-600 bg-zinc-800 px-1.5 py-1"
              value={gate.threshold}
              onChange={(e) => save({ ...gate, threshold: Number(e.target.value) })}
            >
              {[3, 3.5, 4, 4.5, 5].map((v) => (
                <option key={v} value={v}>
                  {v.toFixed(1)}
                </option>
              ))}
            </select>
            <span className="w-40 shrink-0 pl-2 text-zinc-400">差し戻し上限/件</span>
            <select
              className="rounded border border-zinc-600 bg-zinc-800 px-1.5 py-1"
              value={gate.maxRoundsPerMilestone}
              onChange={(e) => save({ ...gate, maxRoundsPerMilestone: Number(e.target.value) })}
            >
              {[0, 1, 2, 3, 4, 5].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-3">
            {(Object.keys(AXIS_LABEL) as (keyof ReviewGateConfig['axes'])[]).map((axis) => (
              <label key={axis} className="flex items-center gap-1 text-zinc-300">
                <input
                  type="checkbox"
                  checked={gate.axes[axis]}
                  onChange={(e) => save({ ...gate, axes: { ...gate.axes, [axis]: e.target.checked } })}
                />
                {AXIS_LABEL[axis]}
              </label>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-500">
            severity方式では「high=要件を満たさない/壊れている」指摘がゼロなら合格
            (medium/lowはカードに記録するだけで差し戻さない)。スコア平均は参考表示。
            マイルストーン
            (AMATERAS_PLAN.mdの項目完了)単位に絞ってバランスを取っている。計画を使わない
            短いタスクでは完了時に1回だけ。UIが無いタスクでは「見た目/UX」軸は自動スキップ。
            上限到達で閾値未満のときは残課題を提示(自律モードOFFなら承認を求める)
          </p>
        </div>
      )}
      {!enabled && (
        <p className="text-xs text-zinc-500">
          ONにすると、マイルストーンごとに「コード品質・見た目UX・要件達成・テストの質」を
          1〜5で辛口採点し、閾値未満なら具体指摘つきで自動差し戻し(worker帯が修正)する
        </p>
      )}
    </div>
  );
}
