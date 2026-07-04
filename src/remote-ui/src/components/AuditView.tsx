import { useCallback, useEffect, useState } from 'react';
import type { AuditEntryView, RemoteApi } from '../api';

const EVENT_LABEL: Record<string, string> = {
  'hard-deny': '🚫 ハード拒否',
  approval: '🔐 承認判断',
  result: '📋 実行結果',
};

export function AuditView({ api }: { api: RemoteApi }): JSX.Element {
  const [entries, setEntries] = useState<AuditEntryView[] | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async (): Promise<void> => {
    setError('');
    try {
      const { entries: fetched } = await api.auditTail(100);
      setEntries(fetched);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="content">
      <div className="btnrow" style={{ justifyContent: 'flex-start', marginBottom: 8 }}>
        <button className="btn-deny" onClick={() => void reload()}>
          再読込
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {entries === null && !error && <p className="muted">読込中…</p>}
      {entries?.length === 0 && (
        <p className="muted">監査ログは空(system スコープの操作が発生すると記録される)。</p>
      )}
      {entries?.map((e, i) => (
        <div key={i} className="audit-entry">
          <div className="ts">{e.ts}</div>
          <div>
            {EVENT_LABEL[e.event] ?? e.event} — <code>{e.tool}</code> ({e.scope})
          </div>
          {e.paths.length > 0 && <div className="paths">{e.paths.join('\n')}</div>}
          <div className="muted">{e.detail}</div>
        </div>
      ))}
    </div>
  );
}
