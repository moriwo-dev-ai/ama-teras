import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentEvent,
  ApprovalRequestPayload,
  ApprovalResolvedPayload,
  EvolutionEvent,
  RemoteSnapshot,
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
      <h1>MyCodex Remote</h1>
      <p className="hint">
        デスクトップの MyCodex → 設定 → リモートアクセス に表示されるトークンを入力する。
        接続URLの末尾に #t=&lt;トークン&gt; を付けて開いた場合は自動で読み込まれる。
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
        <h1>MyCodex</h1>
        <span className={`conn ${store.connected ? 'on' : 'off'}`}>
          {store.connected ? '接続中' : '再接続中…'}
        </span>
      </header>
      {authFailed && <div className="error-banner">認証に失敗した。トークンを確認して再入力を。</div>}
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
