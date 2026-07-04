import { useEffect, useRef, useState } from 'react';
import type { ChatMode } from '../../../shared/types';
import type { RemoteApi } from '../api';
import { useRemoteStore } from '../store';

const STATUS_LABEL: Record<string, string> = {
  idle: '待機中',
  calling_llm: 'モデル応答中…',
  awaiting_approval: '承認待ち(承認タブへ)',
  executing_tool: 'ツール実行中…',
};

export function ChatView({ api }: { api: RemoteApi }): JSX.Element {
  const { messages, status, addLocalUserMessage } = useRemoteStore();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<ChatMode>('normal');
  const [error, setError] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const running = status.activeSessionId !== null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const send = async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    setError('');
    addLocalUserMessage(mode === 'plan' ? `📝 [プラン] ${trimmed}` : trimmed);
    setText('');
    try {
      await api.chatSend(trimmed, mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const cancel = async (): Promise<void> => {
    if (!status.activeSessionId) return;
    try {
      await api.chatCancel(status.activeSessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <div className="content">
        {messages.length === 0 && <p className="muted">まだ会話が無い。下から送信できる。</p>}
        {messages.map((m) =>
          m.role === 'tool' ? (
            <div key={m.id} className="msg tool">
              <div className={`bubble ${m.isError ? 'error' : ''}`}>
                ⚙ {m.name} {m.running ? '実行中…' : m.isError ? '失敗' : '完了'}
                {m.resultContent && `\n${m.resultContent.slice(0, 400)}`}
              </div>
            </div>
          ) : (
            <div key={m.id} className={`msg ${m.role}`}>
              <div className={`bubble ${m.streaming ? 'streaming' : ''}`}>{m.text}</div>
            </div>
          ),
        )}
        <div ref={bottomRef} />
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="statusline">
        {STATUS_LABEL[status.status] ?? status.status}
        {status.scopeMode === 'fullPc' && ' ・ ⚠ fullPc スコープ'}
      </div>
      <div className="modebar">
        <label>
          <input type="radio" checked={mode === 'normal'} onChange={() => setMode('normal')} />
          通常
        </label>
        <label>
          <input type="radio" checked={mode === 'plan'} onChange={() => setMode('plan')} />
          プラン(計画のみ)
        </label>
      </div>
      <div className="composer">
        <textarea
          value={text}
          placeholder="指示を入力…"
          rows={1}
          onChange={(e) => setText(e.target.value)}
        />
        {running ? (
          <button className="cancel" onClick={() => void cancel()}>
            停止
          </button>
        ) : (
          <button className="send" disabled={!text.trim()} onClick={() => void send()}>
            送信
          </button>
        )}
      </div>
    </>
  );
}
