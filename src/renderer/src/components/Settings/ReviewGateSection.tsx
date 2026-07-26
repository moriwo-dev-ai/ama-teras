import type { AppConfig, ReviewGateConfig } from '../../../../shared/types';
import { useT, type MessageKey } from '../../i18n';

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

const PRESETS: { labelKey: MessageKey; threshold: number; rounds: number }[] = [
  { labelKey: 'quality.presetStrict' as MessageKey, threshold: 4.5, rounds: 3 },
  { labelKey: 'quality.presetStandard' as MessageKey, threshold: 4.0, rounds: 2 },
  { labelKey: 'quality.presetLight' as MessageKey, threshold: 3.5, rounds: 1 },
];

const AXIS_LABEL: Record<keyof ReviewGateConfig['axes'], MessageKey> = {
  code: 'quality.axisCode' as MessageKey,
  ux: 'quality.axisUx' as MessageKey,
  requirements: 'quality.axisReq' as MessageKey,
  tests: 'quality.axisTests' as MessageKey,
};

export function ReviewGateSection({
  config,
  onSave,
}: {
  config: AppConfig;
  onSave: (next: AppConfig) => void;
}): JSX.Element {
  const t = useT();
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
        {t('quality.gateHeading')}
      </label>
      {enabled && gate && (
        <div className="space-y-2 rounded border border-zinc-700 bg-zinc-950/50 p-2 text-xs">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.labelKey}
                className="rounded border border-zinc-600 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
                onClick={() => save({ ...gate, threshold: p.threshold, maxRoundsPerMilestone: p.rounds })}
              >
                {t(p.labelKey)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="w-40 shrink-0 text-zinc-400">{t('quality.passMode')}</span>
            <label className="flex items-center gap-1 text-zinc-300">
              <input
                type="radio"
                name="review-pass-mode"
                checked={(gate.passMode ?? 'severity') === 'severity'}
                onChange={() => save({ ...gate, passMode: 'severity' })}
              />
              {t('quality.severityMode')}
            </label>
            <label className="flex items-center gap-1 text-zinc-300">
              <input
                type="radio"
                name="review-pass-mode"
                checked={gate.passMode === 'score'}
                onChange={() => save({ ...gate, passMode: 'score' })}
              />
              {t('quality.scoreMode')}
            </label>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-40 shrink-0 text-zinc-400">
              {t('quality.threshold')}{(gate.passMode ?? 'severity') === 'severity' ? t('quality.thresholdDisplayOnly') : ''}
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
            <span className="w-40 shrink-0 pl-2 text-zinc-400">{t('quality.maxRounds')}</span>
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
                {t(AXIS_LABEL[axis])}
              </label>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-500">{t('quality.gateNote')}</p>
        </div>
      )}
      {!enabled && (
        <p className="text-xs text-zinc-500">{t('quality.offNote')}</p>
      )}
    </div>
  );
}
