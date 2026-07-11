import { useEffect, useState } from 'react';
import type { IwatoRequestPayload } from '../../../../shared/types';

/**
 * M32-2: 岩戸ゲートの共通承認ダイアログ(Protocol AMANO-iwate)。
 * 外部への発信(投稿・コメント・ラベル・マージ)は必ずここを通る:
 * 何を・どこへ・全文プレビュー+媒体の規約メモを表示し、承認後のみ main 側が実行する。
 * このファイルは承認UI(聖域 src/renderer/src/components/Approval)に置く。
 */
export function IwatoApprovalDialog(): JSX.Element | null {
  const [queue, setQueue] = useState<IwatoRequestPayload[]>([]);

  useEffect(
    () =>
      window.api.onOperationsApprovalRequest((req) => {
        setQueue((q) => [...q, req]);
      }),
    [],
  );

  const req = queue[0];
  if (!req) return null;

  const respond = (approved: boolean): void => {
    void window.api.operationsApprovalRespond(req.id, approved);
    setQueue((q) => q.filter((r) => r.id !== req.id));
  };

  return (
    <div className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="anim-pop w-[640px] max-w-[90vw] rounded-lg border border-zinc-600 bg-zinc-900 p-4 shadow-xl">
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded bg-orange-600 px-2 py-0.5 text-xs text-white">外部への発信</span>
          <h2 className="text-sm font-semibold">
            ⛩ 岩戸ゲート: <code className="text-blue-300">{req.adapterId}</code> / {req.action}
          </h2>
          {queue.length > 1 && <span className="text-xs text-zinc-500">(+{queue.length - 1} 件待ち)</span>}
        </div>

        <div className="mb-2 rounded-md border border-orange-700 bg-orange-950 p-2 text-xs text-orange-200">
          この操作はアプリの外(公開の場)に発信されます。取り消せない場合があります。
        </div>

        <div className="mb-2 flex items-baseline gap-2 rounded-md border border-zinc-700 bg-zinc-950 p-2 text-xs">
          <span className="shrink-0 text-zinc-500">どこへ:</span>
          <span className="min-w-0 break-all font-semibold text-zinc-200">{req.target}</span>
        </div>

        <p className="mb-1 text-xs text-zinc-400">全文プレビュー(この内容がそのまま発信される):</p>
        <pre className="mb-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-zinc-700 bg-zinc-950 p-2 text-xs text-zinc-200">
          {req.preview}
        </pre>

        <p className="mb-3 text-xs text-zinc-500">📜 規約メモ: {req.compliance}</p>

        <div className="flex justify-end gap-2">
          <button
            className="rounded-md border border-zinc-600 px-3 py-1.5 text-sm hover:bg-zinc-800"
            onClick={() => respond(false)}
          >
            拒否
          </button>
          {/* 岩戸ゲートにセッション許可は無い(外部発信は毎回・個別承認) */}
          <button
            className="rounded-md bg-orange-600 px-4 py-1.5 text-sm hover:bg-orange-500"
            onClick={() => respond(true)}
          >
            発信を承認
          </button>
        </div>
      </div>
    </div>
  );
}
