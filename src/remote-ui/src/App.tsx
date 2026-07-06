import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentEvent,
  ApprovalRequestPayload,
  ApprovalResolvedPayload,
  EvolutionEvent,
  RemoteSnapshot,
  SessionMeta,
} from '../../shared/types';
import { clearToken, loadToken, RemoteApi, saveToken } from './api';
import { ApprovalsView } from './components/ApprovalsView';
import { AuditView } from './components/AuditView';
import { ChatView } from './components/ChatView';
import { EvolutionView } from './components/EvolutionView';
import { useRemoteStore, type Tab } from './store';

function TokenGate({ onSubmit }: { onSubmit: (token: string) => void }): JSX.Element {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="gate">
      <h1>AMA-teras Remote</h1>
      <p className="hint">
        デスクトップの AMA-teras → 設定 → リモートアクセス に表示されるトークンを入力する。
        接続URLの末尾に #t=&lt;トークン&gt; を付けて開いた場合は自動で読み込まれる。
      </p>
      <p className="hint">
        ホーム画面に追加したアプリから初めて起動した場合、Safariとは保存領域が別のため
        1回だけ入力が必要なことがある(以後は保存される)。QRで開いた直後(URLに #t= が
        付いた状態)にホーム画面へ追加すると、初回から入力不要になる。
      </p>
      <input
        placeholder="ペアリングトークン(64文字)"
        value={value}
        autoCapitalize="none"
        autoCorrect="off"
        onChange={(e) => setValue(e.target.value.trim())}
      />
      {error && <div className="error-banner">{error}</div>}
      <button
        onClick={() => {
          if (!/^[0-9a-f]{64}$/.test(value)) {
            setError('トークンの形式が違う(16進64文字)');
            return;
          }
          onSubmit(value);
        }}
      >
        接続
      </button>
    </div>
  );
}

const TAB_LABEL: Record<Tab, string> = {
  chat: 'チャット',
  approvals: '承認',
  evolution: '進化',
  audit: '監査',
};

export function App(): JSX.Element {
  const [token, setToken] = useState<string | null>(() => loadToken());
  const [authFailed, setAuthFailed] = useState(false);
  const api = useMemo(() => (token ? new RemoteApi(token) : null), [token]);
  const store = useRemoteStore();
  const esRef = useRef<EventSource | null>(null);
  // M15.1: セッション切替
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionError, setSessionError] = useState('');
  const running = store.status.activeSessionId !== null;

  const refreshSessions = useCallback(async () => {
    if (!api) return;
    try {
      setSessions((await api.sessionsList()).sessions);
    } catch {
      /* 一覧取得失敗は次回更新で回復 */
    }
  }, [api]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);
  useEffect(() => {
    if (!running) void refreshSessions();
  }, [running, refreshSessions]);

  const openSession = async (id: string): Promise<void> => {
    if (!api || !id) return;
    setSessionError('');
    try {
      const result = await api.sessionsLoad(id);
      if (!result.ok || !result.history) {
        setSessionError(result.message ?? 'セッションを開けない');
        return;
      }
      useRemoteStore.getState().replaceHistory(result.history);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToken = useCallback((t: string) => {
    saveToken(t);
    setAuthFailed(false);
    setToken(t);
  }, []);

  // SSE 購読。切断時は EventSource が自動再接続し、open ごとに snapshot で状態回復する
  useEffect(() => {
    if (!api) return;
    const {
      applySnapshot,
      onChatEvent,
      onApprovalRequest,
      onApprovalResolved,
      onEvolutionEvent,
      setConnected,
    } = useRemoteStore.getState();

    // トークンが誤っていると EventSource は401→自動再接続を繰り返すだけなので、
    // 先に REST で検証して明確なエラー表示にする
    let cancelled = false;
    void api.status().catch((err: unknown) => {
      if (cancelled) return;
      if (err instanceof Error && (err.message.includes('401') || err.message === 'unauthorized')) {
        clearToken();
        setToken(null);
        setAuthFailed(true);
      }
    });

    const es = api.openEvents();
    esRef.current = es;
    const parse = <T,>(e: MessageEvent): T => JSON.parse(e.data as string) as T;
    es.addEventListener('snapshot', (e) => {
      setConnected(true);
      applySnapshot(parse<RemoteSnapshot>(e));
    });
    es.addEventListener('chat:event', (e) => onChatEvent(parse<AgentEvent>(e)));
    es.addEventListener('approval:request', (e) => onApprovalRequest(parse<ApprovalRequestPayload>(e)));
    es.addEventListener('approval:resolved', (e) => onApprovalResolved(parse<ApprovalResolvedPayload>(e)));
    es.addEventListener('evolution:event', (e) => onEvolutionEvent(parse<EvolutionEvent>(e)));
    es.onerror = () => setConnected(false);
    return () => {
      cancelled = true;
      es.close();
      esRef.current = null;
    };
  }, [api]);

  if (!token || !api) return <TokenGate onSubmit={handleToken} />;

  const pendingCount = store.pendingApprovals.length + store.promotions.length;

  return (
    <div className="app">
      <header className="topbar">
        <h1>AMA-teras</h1>
        <select
          className="session-select"
          value=""
          disabled={running}
          onFocus={() => void refreshSessions()}
          onChange={(e) => void openSession(e.target.value)}
          title={running ? '実行中は切替不可' : 'セッションを開く'}
        >
          <option value="">セッション…</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {(s.title || '(無題)').slice(0, 30)}
            </option>
          ))}
        </select>
        <span className={`conn ${store.connected ? 'on' : 'off'}`}>
          {store.connected ? '接続中' : '再接続中…'}
        </span>
      </header>
      {authFailed && <div className="error-banner">認証に失敗した。トークンを確認して再入力を。</div>}
      {sessionError && <div className="error-banner">{sessionError}</div>}
      <nav className="tabs">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <button key={t} className={store.tab === t ? 'active' : ''} onClick={() => store.setTab(t)}>
            {TAB_LABEL[t]}
            {t === 'approvals' && pendingCount > 0 && <span className="badge">{pendingCount}</span>}
          </button>
        ))}
      </nav>
      {store.tab === 'chat' && <ChatView api={api} />}
      {store.tab === 'approvals' && <ApprovalsView api={api} />}
      {store.tab === 'evolution' && <EvolutionView api={api} />}
      {store.tab === 'audit' && <AuditView api={api} />}
    </div>
  );
}
