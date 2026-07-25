import { useEffect, useState } from 'react';
import type { AutonomousRegistryScope } from '../../../../shared/types';
import { useT } from '../../i18n';

/**
 * M17-2: 自律モードON時の危険警告モーダル。
 * 「リスクを理解しました」にチェックを入れない限り有効化できない。
 * M29-5: プラグイン導入の包括承認範囲をこの実行単位で選択する(既定は設定値)
 */
export function AutonomousModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: (registryScope: AutonomousRegistryScope) => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useT();
  const [understood, setUnderstood] = useState(false);
  const [registryScope, setRegistryScope] = useState<AutonomousRegistryScope>('none');

  useEffect(() => {
    // 既定値は設定(autonomousRegistryScope)から。取得失敗時は none のまま
    void window.api
      .settingsGet()
      .then((c) => setRegistryScope(c.autonomousRegistryScope ?? 'none'))
      .catch(() => {});
  }, []);

  return (
    <div className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div
        className="anim-pop w-[480px] max-w-[90vw] rounded-lg border border-amber-600 bg-zinc-900 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-2 text-sm font-bold text-amber-400">{t('auto.title')}</h3>
        <p className="mb-2 text-xs leading-relaxed text-zinc-300">
          {t('auto.warnPre')}
          <span className="font-bold text-amber-300">{t('auto.warnBold')}</span>
          {t('auto.warnPost')}
        </p>
        <ul className="mb-3 list-inside list-disc space-y-0.5 text-[11px] text-zinc-400">
          <li>{t('auto.bullet1')}</li>
          <li>{t('auto.bullet2')}</li>
          <li>{t('auto.bullet3')}</li>
        </ul>
        {/* M29-5: 包括承認 — プラグインの仮導入をこの実行でどこまで許すか */}
        <div className="mb-3 space-y-1 rounded border border-zinc-700 bg-zinc-950 p-2">
          <p className="text-xs font-semibold text-zinc-300">{t('auto.scopeHeading')}</p>
          <div className="space-y-0.5 text-[11px] text-zinc-300">
            {(
              [
                ['none', t('auto.scopeNone')],
                ['verified', t('auto.scopeVerified')],
                ['verified-generate', t('auto.scopeVerifiedGen')],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="registryScope"
                  className="mt-0.5"
                  checked={registryScope === value}
                  onChange={() => setRegistryScope(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <p className="text-[10px] text-zinc-500">{t('auto.scopeNote')}</p>
        </div>
        <label className="mb-3 flex items-center gap-2 text-xs text-zinc-200">
          <input
            type="checkbox"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
          />
          {t('auto.understood')}
        </label>
        <div className="flex justify-end gap-2 text-xs">
          <button
            className="rounded border border-zinc-600 px-3 py-1.5 text-zinc-300 hover:bg-zinc-800"
            onClick={onCancel}
          >
            {t('auto.cancel')}
          </button>
          <button
            className="rounded bg-amber-600 px-3 py-1.5 font-semibold text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!understood}
            onClick={() => onConfirm(registryScope)}
          >
            {t('auto.enable')}
          </button>
        </div>
      </div>
    </div>
  );
}
