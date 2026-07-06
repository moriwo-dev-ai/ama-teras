import { useState } from 'react';

/**
 * M17-2: 自律モードON時の危険警告モーダル。
 * 「リスクを理解しました」にチェックを入れない限り有効化できない。
 */
export function AutonomousModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [understood, setUnderstood] = useState(false);
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
            onClick={onConfirm}
          >
            有効化(自己責任)
          </button>
        </div>
      </div>
    </div>
  );
}
