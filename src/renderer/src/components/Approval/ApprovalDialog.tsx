import { useT } from '../../i18n';
import { useApprovalStore } from '../../stores/approval';
import { DiffView } from '../DiffView/DiffView';

const RISK_LABEL = {
  safe: { key: 'approval.riskSafe', cls: 'bg-zinc-600' },
  write: { key: 'approval.riskWrite', cls: 'bg-amber-600' },
  exec: { key: 'approval.riskExec', cls: 'bg-red-600' },
} as const;

export function ApprovalDialog(): JSX.Element | null {
  const t = useT();
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
          <span className={`rounded px-2 py-0.5 text-xs text-white ${risk.cls}`}>{t(risk.key)}</span>
          <h2 className="text-sm font-semibold">
            {t('approval.title')} <code className="text-blue-300">{req.toolName}</code>
          </h2>
          {queue.length > 1 && (
            <span className="text-xs text-zinc-500">{t('approval.queued', { n: queue.length - 1 })}</span>
          )}
        </div>

        {/* M22: どの会話(プロジェクト)からの要求か(複数同時実行時の取り違え防止) */}
        {req.origin !== undefined && (
          <div className="mb-2 flex items-baseline gap-2 rounded-md border border-zinc-700 bg-zinc-950 p-2 text-xs">
            <span className="shrink-0 text-zinc-500">{t('approval.origin')}</span>
            <span className="min-w-0 shrink-0 truncate font-semibold text-zinc-200" title={req.origin.workspace}>
              📁 {req.origin.workspace.split(/[\\/]/).filter(Boolean).pop() ?? req.origin.workspace}
            </span>
            <span className="min-w-0 truncate text-zinc-400">{req.origin.title}</span>
          </div>
        )}

        {/* M28-1: 保護領域(聖域)への変更は最上位の赤バナーで明示(手動承認のみ到達する) */}
        {req.sanctuary === true && (
          <div className="mb-2 rounded-md border-2 border-red-500 bg-red-950 p-2 text-xs text-red-200">
            <div className="mb-1 font-semibold">{t('approval.sanctuaryTitle')}</div>
            <div className="text-red-300/90">{t('approval.sanctuaryBody')}</div>
          </div>
        )}

        {req.subAgentId !== undefined && (
          <div className="mb-2 rounded-md border border-sky-700 bg-sky-950 p-2 text-xs text-sky-200">
            {t('approval.subAgent', { id: req.subAgentId })}
          </div>
        )}

        {req.mcpServer !== undefined && (
          <div className="mb-2 rounded-md border border-purple-700 bg-purple-950 p-2 text-xs text-purple-200">
            {t('approval.mcp', { server: req.mcpServer })}
          </div>
        )}

        {isSystemScope && (
          <div className="mb-2 rounded-md border border-amber-500 bg-amber-950 p-2 text-xs text-amber-200">
            <div className="mb-1 font-semibold">{t('approval.fullPcTitle')}</div>
            <div className="text-amber-300/90">{t('approval.fullPcBody')}</div>
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
            <p className="mb-1 text-xs text-zinc-400">{t('approval.diff')}</p>
            <DiffView lines={req.diff} />
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            className="rounded-md border border-zinc-600 px-3 py-1.5 text-sm hover:bg-zinc-800"
            onClick={() => respond(req.id, 'deny')}
          >
            {t('approval.deny')}
          </button>
          {/* M14-5: systemスコープは原則ボタン非表示。fullPcAllowSession ON のとき
              だけ main が allowSessionLabel を付けてくるので、その場合のみ表示する */}
          {(!isSystemScope || req.allowSessionLabel) && (
            <button
              className="rounded-md border border-zinc-600 px-3 py-1.5 text-sm hover:bg-zinc-800"
              onClick={() => respond(req.id, 'allow-session')}
            >
              {req.allowSessionLabel
                ? t('approval.allowSessionLabeled', { label: req.allowSessionLabel })
                : t('approval.allowSession')}
            </button>
          )}
          <button
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm hover:bg-blue-500"
            onClick={() => respond(req.id, 'allow')}
          >
            {t('approval.allow')}
          </button>
        </div>
      </div>
    </div>
  );
}
