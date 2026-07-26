import type { AppConfig } from '../../../../shared/types';
import { useT } from '../../i18n';
import { ReviewGateSection } from './ReviewGateSection';

/**
 * M26-5: 設定「品質」タブ — ReviewGate / ツール自動承認 / 編集後フック。
 * 状態は SettingsPanel に集約し props で受ける
 */
export function QualitySection({
  config,
  saveConfig,
  updateConfig,
}: {
  config: AppConfig;
  saveConfig: (next: AppConfig) => void;
  updateConfig: (patch: Partial<AppConfig>) => Promise<void>;
}): JSX.Element {
  const t = useT();
  return (
    <div className="space-y-4">
      {/* M19: 品質レビュー・ゲート */}
      <ReviewGateSection config={config} onSave={saveConfig} />

      <div className="space-y-1">
        <label className="text-xs text-zinc-400">{t('quality.autoApprove')}</label>
        <div className="flex gap-4 text-xs text-zinc-300">
          {(['safe', 'write', 'exec'] as const).map((k) => (
            <label key={k} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={config.autoApprove[k]}
                onChange={() =>
                  void updateConfig({
                    autoApprove: { ...config.autoApprove, [k]: !config.autoApprove[k] },
                  })
                }
              />
              {k}
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-zinc-400">{t('quality.postEditHook')}</label>
        <input
          className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs"
          defaultValue={config.postEditHook ?? ''}
          placeholder={t('quality.hookPlaceholder')}
          onBlur={(e) => {
            const raw = e.target.value.trim();
            const next: AppConfig = { ...config };
            delete next.postEditHook;
            if (raw !== '') next.postEditHook = raw;
            saveConfig(next);
          }}
        />
        <p className="text-xs text-zinc-500">
          {t('quality.hookNote')}
        </p>
      </div>

      {/* M27-4: キルスイッチ(プラグイン失効リスト) */}
      <div className="space-y-1">
        <label className="text-xs text-zinc-400">{t('quality.revocationUrl')}</label>
        <input
          className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs"
          defaultValue={config.pluginRevocationUrl ?? ''}
          placeholder="例: https://…/revoked.json(空欄=チェックしない)"
          onBlur={(e) => {
            const raw = e.target.value.trim();
            const next: AppConfig = { ...config };
            delete next.pluginRevocationUrl;
            if (raw !== '') next.pluginRevocationUrl = raw;
            saveConfig(next);
          }}
        />
        <p className="text-xs text-zinc-500">
          {t('quality.revocationNote')}
        </p>
      </div>
    </div>
  );
}
