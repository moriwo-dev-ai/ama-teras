import type { AppConfig } from '../../../../shared/types';
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
  return (
    <div className="space-y-4">
      {/* M19: 品質レビュー・ゲート */}
      <ReviewGateSection config={config} onSave={saveConfig} />

      <div className="space-y-1">
        <label className="text-xs text-zinc-400">ツール自動承認</label>
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
        <label className="text-xs text-zinc-400">編集後フック(postEditHook)</label>
        <input
          className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs"
          defaultValue={config.postEditHook ?? ''}
          placeholder="例: npx vitest run --changed"
          onBlur={(e) => {
            const raw = e.target.value.trim();
            const next: AppConfig = { ...config };
            delete next.postEditHook;
            if (raw !== '') next.postEditHook = raw;
            saveConfig(next);
          }}
        />
        <p className="text-xs text-zinc-500">
          write_file / edit_file が成功するたびに作業ディレクトリで実行され、出力(末尾4KB)が
          ツール結果に追記される。エラーをモデルが見て自走修正できる(タイムアウト60秒・空欄=無効)
        </p>
      </div>
    </div>
  );
}
