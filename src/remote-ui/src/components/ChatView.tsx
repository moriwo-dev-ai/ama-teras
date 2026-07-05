import { useEffect, useRef, useState } from 'react';
import type { ChatImageInput, ChatMode } from '../../../shared/types';
import type { RemoteApi } from '../api';
import { useRemoteStore } from '../store';

/** M14-3: File → base64 添付(スマホのカメラ/フォトライブラリから) */
async function fileToAttachment(file: File): Promise<ChatImageInput | null> {
  if (!file.type.startsWith('image/')) return null;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('読み込み失敗'));
    reader.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  return { mediaType: file.type, data: dataUrl.slice(comma + 1), description: file.name || 'photo' };
}

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
  const [attachments, setAttachments] = useState<ChatImageInput[]>([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const running = status.activeSessionId !== null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const send = async (): Promise<void> => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || running) return;
    setError('');
    const label = attachments.length > 0 ? `🖼×${attachments.length} ${trimmed}` : trimmed;
    addLocalUserMessage(mode === 'plan' ? `📝 [プラン] ${label}` : label);
    const images = attachments.length > 0 ? attachments : undefined;
    setText('');
    setAttachments([]);
    try {
      await api.chatSend(trimmed || '(画像を確認して)', mode, images);
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
      {attachments.length > 0 && (
        <div className="modebar" style={{ gap: 8, flexWrap: 'wrap' }}>
          {attachments.map((a, i) => (
            <span key={i} style={{ position: 'relative', display: 'inline-block' }}>
              <img
                src={`data:${a.mediaType};base64,${a.data}`}
                alt="添付"
                style={{ height: 48, width: 48, objectFit: 'cover', borderRadius: 6 }}
              />
              <button
                style={{ position: 'absolute', top: -6, right: -6, fontSize: 10 }}
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            void (async () => {
              const added: ChatImageInput[] = [];
              for (const f of e.target.files ?? []) {
                const a = await fileToAttachment(f).catch(() => null);
                if (a) added.push(a);
              }
              if (added.length > 0) setAttachments((prev) => [...prev, ...added].slice(0, 8));
              if (fileRef.current) fileRef.current.value = '';
            })();
          }}
        />
        <button className="send" style={{ minWidth: 40 }} onClick={() => fileRef.current?.click()}>
          📷
        </button>
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
