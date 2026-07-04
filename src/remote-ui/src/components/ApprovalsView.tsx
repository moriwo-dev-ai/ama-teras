import { useState } from 'react';
import type { ApprovalRequestPayload } from '../../../shared/types';
import type { RemoteApi } from '../api';
import { useRemoteStore } from '../store';

const RISK_LABEL: Record<ApprovalRequestPayload['risk'], string> = {
  safe: '読み取り',
  write: '書き込み',
  exec: '実行',
};

function ApprovalCard({ req, api }: { req: ApprovalRequestPayload; api: RemoteApi }): JSX.Element {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isSystem = req.scope === 'system';

  const respond = async (decision: 'allow' | 'deny'): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      // リモートからは allow-session を出さない(サーバ側でも allow に降格される)
      await api.approvalRespond(req.id, decision);
      // 一覧からの除去は approval:resolved イベントで行う(デスクトップと競合しても一貫)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>
        <span className={`risk ${req.risk}`}>{RISK_LABEL[req.risk]}</span>
        {req.toolName}
      </h3>
      {isSystem && (
        <div className="warn-banner">
          ⚠ プロジェクト外の操作(PC全体スコープ)。毎回承認が必要。
          {req.resolvedPaths?.map((p) => (
            <div key={p} style={{ fontFamily: 'monospace' }}>
              {p}
            </div>
          ))}
        </div>
      )}
      {req.warnings.length > 0 && (
        <div className="error-banner">
          {req.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}
      <pre className="preview">{req.inputPreview}</pre>
      {req.diff && req.diff.length > 0 && (
        <div className="diff">
          {req.diff.map((line, i) => (
            <div key={i} className={line.kind}>
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '} {line.text}
            </div>
          ))}
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}
      <div className="btnrow">
        <button className="btn-deny" disabled={busy} onClick={() => void respond('deny')}>
          拒否
        </button>
        <button className="btn-allow" disabled={busy} onClick={() => void respond('allow')}>
          許可
        </button>
      </div>
    </div>
  );
}

function PromotionCard({ api, jobId }: { api: RemoteApi; jobId: number }): JSX.Element {
  const promotion = useRemoteStore((s) => s.promotions.find((p) => p.jobId === jobId));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!promotion) return <></>;

  const respond = async (approved: boolean): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await api.evolutionPromoteRespond(promotion.jobId, approved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>🧬 進化ジョブ #{promotion.jobId} の昇格承認: {promotion.toolName}</h3>
      {promotion.warnings.length > 0 && (
        <div className="error-banner">
          {promotion.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}
      <pre className="preview">{promotion.diff}</pre>
      {error && <div className="error-banner">{error}</div>}
      <div className="btnrow">
        <button className="btn-deny" disabled={busy} onClick={() => void respond(false)}>
          却下
        </button>
        <button className="btn-approve" disabled={busy} onClick={() => void respond(true)}>
          昇格を承認
        </button>
      </div>
    </div>
  );
}

export function ApprovalsView({ api }: { api: RemoteApi }): JSX.Element {
  const { pendingApprovals, promotions } = useRemoteStore();
  return (
    <div className="content">
      {pendingApprovals.length === 0 && promotions.length === 0 && (
        <p className="muted">承認待ちは無い。</p>
      )}
      {pendingApprovals.map((req) => (
        <ApprovalCard key={req.id} req={req} api={api} />
      ))}
      {promotions.map((p) => (
        <PromotionCard key={p.jobId} api={api} jobId={p.jobId} />
      ))}
    </div>
  );
}
