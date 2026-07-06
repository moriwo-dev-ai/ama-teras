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
  // M9: system スコープは毎回承認(allow-session を出さない)+警告バナー
  const isSystemScope = req.scope === 'system';

  return (
    <div className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="anim-pop w-[640px] max-w-[90vw] rounded-lg border border-zinc-600 bg-zinc-900 p-4 shadow-xl">
        <div className="mb-2 flex items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-xs text-white ${risk.cls}`}>{risk.text}</span>
          <h2 className="text-sm font-semibold">
            ツール実行の承認: <code className="text-blue-300">{req.toolName}</code>
          </h2>
          {queue.length > 1 && <span className="text-xs text-zinc-500">(+{queue.length - 1} 件待ち)</span>}
        </div>

        {/* M22: どの会話(プロジェクト)からの要求か(複数同時実行時の取り違え防止) */}
        {req.origin !== undefined && (
          <div className="mb-2 flex items-baseline gap-2 rounded-md border border-zinc-700 bg-zinc-950 p-2 text-xs">
            <span className="shrink-0 text-zinc-500">出所:</span>
            <span className="truncate font-semibold text-zinc-200" title={req.origin.workspace}>
              📁 {req.origin.workspace.split(/[\\/]/).filter(Boolean).pop() ?? req.origin.workspace}
            </span>
            <span className="truncate text-zinc-400">{req.origin.title}</span>
          </div>
        )}

        {req.subAgentId !== undefined && (
          <div className="mb-2 rounded-md border border-sky-700 bg-sky-950 p-2 text-xs text-sky-200">
            🤖 サブエージェント #{req.subAgentId} からの要求(dispatch_agent 経由の並列作業)
          </div>
        )}

        {req.mcpServer !== undefined && (
          <div className="mb-2 rounded-md border border-purple-700 bg-purple-950 p-2 text-xs text-purple-200">
            🔌 MCP: {req.mcpServer} — 外部MCPサーバーのツール(パスベースのスコープ判定対象外)
          </div>
        )}

        {isSystemScope && (
          <div className="mb-2 rounded-md border border-amber-500 bg-amber-950 p-2 text-xs text-amber-200">
            <div className="mb-1 font-semibold">⚠ プロジェクト外の操作(PC全体スコープ)</div>
            <div className="text-amber-300/90">この操作は作業ディレクトリの外に影響する。毎回承認が必要。</div>
            {req.resolvedPaths && req.resolvedPaths.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {req.resolvedPaths.map((p) => (
                  <li key={p} className="break-all font-mono text-amber-100">
                    {p}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

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
          {/* M14-5: systemスコープは原則ボタン非表示。fullPcAllowSession ON のとき
              だけ main が allowSessionLabel を付けてくるので、その場合のみ表示する */}
          {(!isSystemScope || req.allowSessionLabel) && (
            <button
              className="rounded-md border border-zinc-600 px-3 py-1.5 text-sm hover:bg-zinc-800"
              onClick={() => respond(req.id, 'allow-session')}
            >
              {req.allowSessionLabel
                ? `このセッションでは常に許可(${req.allowSessionLabel})`
                : 'このセッションでは常に許可'}
            </button>
          )}
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
