import { useEffect, useState } from 'react';
import type { AutonomousRegistryScope } from '../../../../shared/types';

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
        <h3 className="mb-2 text-sm font-bold text-amber-400">🔓 自律モードを有効化しますか?</h3>
        <p className="mb-2 text-xs leading-relaxed text-zinc-300">
          自律モードでは、ファイル変更・コマンド実行・システム領域の操作を
          <span className="font-bold text-amber-300">確認なしで実行</span>します。
          AIが誤った操作をしても止まりません。
        </p>
        <ul className="mb-3 list-inside list-disc space-y-0.5 text-[11px] text-zinc-400">
          <li>APIキー(secrets)とアプリ設定領域の破壊、OSを壊す破壊的コマンドだけは自動で拒否されます</li>
          <li>実行された全操作は監査ログ(audit.jsonl)に記録されます</li>
          <li>このセッション限り有効(アプリ再起動・セッション切替でOFFに戻ります)</li>
        </ul>
        {/* M29-5: 包括承認 — プラグインの仮導入をこの実行でどこまで許すか */}
        <div className="mb-3 space-y-1 rounded border border-zinc-700 bg-zinc-950 p-2">
          <p className="text-xs font-semibold text-zinc-300">プラグイン導入の包括承認(この実行のみ)</p>
          <div className="space-y-0.5 text-[11px] text-zinc-300">
            {(
              [
                ['none', '自動導入なし — 手持ちツールと新規生成のみ(生成の反映は従来どおり昇格承認待ち)'],
                ['verified', '検証済みのみ仮導入(推奨)— レジストリの検証済み+危険権限なしを無人で仮導入'],
                ['verified-generate', '検証済み+生成も仮導入 — 上記に加え自己生成プラグインも無人で仮導入'],
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
          <p className="text-[10px] text-zinc-500">
            仮導入も検証3段(typecheck→テスト→スモーク)を必ず通り、危険権限(ネットワーク/外部プロセス)持ちは
            範囲に関わらず無人導入されません。終了時の棚卸しカードで「残す/削除」を最終確認します
          </p>
        </div>
        <label className="mb-3 flex items-center gap-2 text-xs text-zinc-200">
          <input
            type="checkbox"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
          />
          リスクを理解しました
        </label>
        <div className="flex justify-end gap-2 text-xs">
          <button
            className="rounded border border-zinc-600 px-3 py-1.5 text-zinc-300 hover:bg-zinc-800"
            onClick={onCancel}
          >
            キャンセル
          </button>
          <button
            className="rounded bg-amber-600 px-3 py-1.5 font-semibold text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!understood}
            onClick={() => onConfirm(registryScope)}
          >
            有効化(自己責任)
          </button>
        </div>
      </div>
    </div>
  );
}
