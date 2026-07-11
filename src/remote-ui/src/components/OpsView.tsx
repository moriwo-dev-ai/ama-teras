import { useCallback, useEffect, useState } from 'react';
import type {
  ApprovalBatch,
  GodClockJob,
  InboxItem,
  IwatoRequestPayload,
  MetricsSnapshot,
  OpsThreadMessage,
} from '../../../shared/types';
import type { RemoteApi } from '../api';

/**
 * M34-6: リモートUIの「運営」タブ — 出先のスマホだけで運営が完結する:
 * ①岩戸ゲートの実行承認(全文プレビュー) ②神議の承認バッチ ③⛩スレッド閲覧・返信
 * ④ダッシュボード(神々の時計・主要数字・受け箱)。設定変更はPC側限定。
 * 既存remote-uiのパターン(card / warn-banner / muted)に従い狭幅で崩れない構成。
 */

const GOD_LABEL: Record<string, string> = {
  'omoi-kami': '🧠 観測',
  'uzume-patrol': '💃 巡回',
  'uzume-drafts': '💃 下書き',
  'tedika-rao': '💪 門番',
  kamuhakari: '⛩ 神議',
};

function IwatoCard({ req, api, onDone }: { req: IwatoRequestPayload; api: RemoteApi; onDone: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const respond = async (approved: boolean): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await api.opsIwatoRespond(req.id, approved);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h3>⛩ 外部への発信: {req.adapterId} / {req.action}</h3>
      <div className="warn-banner">この操作はアプリの外(公開の場)に発信されます</div>
      <div className="muted" style={{ fontSize: 12 }}>どこへ: {req.target}</div>
      <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>{req.preview}</pre>
      <div className="muted" style={{ fontSize: 11 }}>📜 {req.compliance}</div>
      {error && <div className="error-banner">{error}</div>}
      <div className="row">
        <button disabled={busy} onClick={() => void respond(false)}>拒否</button>
        <button disabled={busy} className="primary" onClick={() => void respond(true)}>発信を承認</button>
      </div>
    </div>
  );
}

function BatchCard({ batch, api, onDone }: { batch: ApprovalBatch; api: RemoteApi; onDone: () => void }): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const pending = batch.items.filter((i) => i.status === 'pending');
  if (pending.length === 0) return <></>;
  return (
    <div className="card">
      <h3>⛩ 神議の承認バッチ({batch.ts.slice(5, 16)})</h3>
      <p className="muted" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{batch.analysis}</p>
      {pending.map((item) => (
        <div key={item.id} style={{ borderTop: '1px solid #333', paddingTop: 8, marginTop: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{item.title}</div>
          <div className="muted" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{item.detail}</div>
          <div className="row">
            <button
              disabled={busy !== null}
              onClick={() => {
                setBusy(item.id);
                void api.opsBatchRespond(batch.id, item.id, false).finally(() => {
                  setBusy(null);
                  onDone();
                });
              }}
            >
              却下
            </button>
            <button
              disabled={busy !== null}
              className="primary"
              onClick={() => {
                setBusy(item.id);
                void api.opsBatchRespond(batch.id, item.id, true).finally(() => {
                  setBusy(null);
                  onDone();
                });
              }}
            >
              承認
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function OpsView({ api }: { api: RemoteApi }): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [clocks, setClocks] = useState<GodClockJob[]>([]);
  const [inbox, setInbox] = useState<(InboxItem & { read: boolean })[]>([]);
  const [latest, setLatest] = useState<MetricsSnapshot | null>(null);
  const [iwato, setIwato] = useState<IwatoRequestPayload[]>([]);
  const [batches, setBatches] = useState<ApprovalBatch[]>([]);
  const [messages, setMessages] = useState<OpsThreadMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const reload = useCallback((): void => {
    void api.opsSummary().then((s) => {
      setEnabled(s.enabled);
      setClocks(s.clocks);
      setInbox(s.inbox);
      setLatest(s.latest);
      setIwato(s.pendingIwato);
    }).catch(() => setEnabled(false));
    void api.opsBatches().then((b) => setBatches(b.batches)).catch(() => {});
    void api.opsThread().then((t) => setMessages(t.messages)).catch(() => {});
  }, [api]);

  useEffect(() => {
    reload();
    const timer = setInterval(reload, 30_000);
    return () => clearInterval(timer);
  }, [reload]);

  if (enabled === null) return <p className="muted">読込中…</p>;
  if (!enabled) return <p className="muted">オーナーモードがOFF(デスクトップの設定→接続で有効化)</p>;

  const stars = latest ? Object.values(latest.github).reduce((a, m) => a + m.stars, 0) : null;
  const liked = latest ? Object.values(latest.zenn).reduce((a, m) => a + m.liked, 0) : null;
  const hatena = latest?.hatena !== undefined ? Object.values(latest.hatena).reduce((a, c) => a + c, 0) : null;

  return (
    <div>
      {/* 承認待ち(最優先で上に) */}
      {iwato.map((req) => (
        <IwatoCard key={req.id} req={req} api={api} onDone={reload} />
      ))}
      {batches.map((b) => (
        <BatchCard key={b.id} batch={b} api={api} onDone={reload} />
      ))}

      {/* 主要数字 */}
      <div className="card">
        <h3>📊 いまの数字</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 14 }}>
          {stars !== null && <span>★ {stars}</span>}
          {liked !== null && <span>Zenn♥ {liked}</span>}
          {hatena !== null && <span>B! {hatena}</span>}
          {latest?.hn?.karma !== undefined && <span>HN karma {latest.hn.karma}</span>}
        </div>
        {latest !== null && <div className="muted" style={{ fontSize: 11 }}>観測: {latest.ts.slice(5, 16)}</div>}
      </div>

      {/* 神々の時計 */}
      <div className="card">
        <h3>🕐 神々の時計</h3>
        {clocks.map((j) => (
          <div key={j.id} className="muted" style={{ fontSize: 12 }}>
            {j.enabled ? '●' : '○'} {GOD_LABEL[j.godId] ?? j.godId}{' '}
            {j.dailyTimes !== undefined ? `毎日${j.dailyTimes.join('/')}` : `${j.intervalMin}分毎`}
            {j.nextRun !== undefined ? ` 次${j.nextRun.slice(11, 16)}` : ''} 今日{j.spentToday.toLocaleString()}tok
          </div>
        ))}
        <div className="muted" style={{ fontSize: 11 }}>設定変更はPC側から</div>
      </div>

      {/* 受け箱 */}
      <div className="card">
        <h3>📥 受け箱</h3>
        {inbox.length === 0 && <p className="muted">空</p>}
        {inbox.slice(0, 15).map((i) => (
          <div key={i.id} className="muted" style={{ fontSize: 12, opacity: i.read ? 0.5 : 1 }}>
            {i.ts.slice(5, 16)} {i.title}
          </div>
        ))}
      </div>

      {/* ⛩スレッド */}
      <div className="card">
        <h3>⛩ 運営スレッド</h3>
        {messages.slice(-20).map((m) => (
          <div key={m.id} style={{ marginBottom: 6, fontSize: 13 }}>
            <span className="muted" style={{ fontSize: 11 }}>
              {m.role === 'user' ? 'あなた' : m.role === 'kamuhakari' ? '🧠 神議' : '⚙'} {m.ts.slice(5, 16)}
            </span>
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</div>
          </div>
        ))}
        <div className="row">
          <input
            style={{ flex: 1, minWidth: 0 }}
            placeholder="神議への相談・指示"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button
            disabled={sending || input.trim() === ''}
            className="primary"
            onClick={() => {
              setSending(true);
              void api
                .opsThreadSend(input.trim())
                .then((t) => {
                  setMessages(t.messages);
                  setInput('');
                })
                .finally(() => setSending(false));
            }}
          >
            {sending ? '…' : '送信'}
          </button>
        </div>
      </div>
    </div>
  );
}
