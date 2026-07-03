import { useApprovalStore } from '../../stores/approval';
import { DiffView } from '../DiffView/DiffView';

const RISK_LABEL = {
  safe: { text: '読み取り', cls: 'bg-zinc-600' },
  write: { text: '書き込み', cls: 'bg-amber-600' },
  exec: { text: '実行', cls: 'bg-red-600' },
} as const;

export function ApprovalDialog(): JSX.Element | null {
  const { queue, respond } = useApprovalStore();
  const req = queue[0];
  if (!req) return null;

  const risk = RISK_LABEL[req.risk];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[640px] max-w-[90vw] rounded-lg border border-zinc-600 bg-zinc-900 p-4 shadow-xl">
        <div className="mb-2 flex items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-xs text-white ${risk.cls}`}>{risk.text}</span>
          <h2 className="text-sm font-semibold">
            ツール実行の承認: <code className="text-blue-300">{req.toolName}</code>
          </h2>
          {queue.length > 1 && <span className="text-xs text-zinc-500">(+{queue.length - 1} 件待ち)</span>}
        </div>

        {req.warnings.length > 0 && (
          <div className="mb-2 rounded-md border border-red-700 bg-red-950 p-2 text-xs text-red-300">
            {req.warnings.map((w, i) => (
              <div key={i}>⚠ {w}</div>
            ))}
          </div>
        )}

        <pre className="mb-2 max-h-40 overflow-auto rounded-md border border-zinc-700 bg-zinc-950 p-2 text-xs text-zinc-300">
          {req.inputPreview}
        </pre>

        {req.diff && req.diff.length > 0 && (
          <div className="mb-2">
            <p className="mb-1 text-xs text-zinc-400">変更内容:</p>
            <DiffView lines={req.diff} />
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            className="rounded-md border border-zinc-600 px-3 py-1.5 text-sm hover:bg-zinc-800"
            onClick={() => respond(req.id, 'deny')}
          >
            拒否
          </button>
          <button
            className="rounded-md border border-zinc-600 px-3 py-1.5 text-sm hover:bg-zinc-800"
            onClick={() => respond(req.id, 'allow-session')}
          >
            このセッションでは常に許可
          </button>
          <button
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm hover:bg-blue-500"
            onClick={() => respond(req.id, 'allow')}
          >
            許可
          </button>
        </div>
      </div>
    </div>
  );
}
