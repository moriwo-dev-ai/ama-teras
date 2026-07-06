import { useEffect, useRef, useState } from 'react';
import type { ChatImageInput } from '../../../../shared/types';
import { useChatStore, type UiMessage } from '../../stores/chat';
import { usePreviewStore } from '../../stores/preview';
import { AutonomousModal } from './AutonomousModal';
import { MarkdownMessage } from './MarkdownMessage';
import { ReviewCard } from './ReviewCard';

/** ツール入力JSONから path を取り出す(write_file/read_file/edit_file等のリンク化用) */
function pathFromInputPreview(inputPreview: string): string | null {
  const m = /"path"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(inputPreview);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return null;
  }
}

/** M14-2: File → base64 添付(データURLのプレフィックスを剥がす) */
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
  return { mediaType: file.type, data: dataUrl.slice(comma + 1), description: file.name || 'pasted-image' };
}

function ToolCard({ msg }: { msg: Extract<UiMessage, { role: 'tool' }> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const openPreview = usePreviewStore((s) => s.open);
  const path = pathFromInputPreview(msg.inputPreview);
  return (
    <div className="anim-appear flex justify-start">
      <div
        className={`max-w-[85%] rounded-md border px-3 py-1.5 text-xs ${
          msg.isError ? 'border-red-700 bg-red-950' : 'border-zinc-700 bg-zinc-900'
        }`}
      >
        <button
          className="flex items-center gap-2 text-zinc-300"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="font-mono text-blue-300">{msg.name}</span>
          <span className="max-w-[360px] truncate text-zinc-500">{msg.inputPreview}</span>
          {msg.images && msg.images.length > 0 && <span>🖼</span>}
          {msg.running && <span className="anim-pulse text-zinc-400">実行中…</span>}
          {!msg.running && <span className="text-zinc-500">{open ? '▲' : '▼'}</span>}
        </button>
        {path && (
          <button
            className="mt-0.5 block truncate font-mono text-[11px] text-blue-300 underline decoration-dotted hover:text-blue-200"
            title={`${path} をプレビュー`}
            onClick={() => void openPreview(path)}
          >
            📄 {path}
          </button>
        )}
        {msg.images && msg.images.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-2">
            {msg.images.map((src, i) => (
              <img
                key={i}
                src={src}
                alt="ツール結果画像"
                className="max-h-48 max-w-[320px] rounded border border-zinc-700 object-contain"
              />
            ))}
          </div>
        )}
        {open && msg.resultContent && (
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap border-t border-zinc-700 pt-1 text-zinc-400">
            {msg.resultContent}
          </pre>
        )}
      </div>
    </div>
  );
}

export function ChatView(): JSX.Element {
  const {
    messages,
    status,
    activeSessionId,
    sessions,
    send,
    cancel,
    refreshSessions,
    loadSession,
    newSession,
  } = useChatStore();
  const [input, setInput] = useState('');
  const [planMode, setPlanMode] = useState(false);
  const [attachments, setAttachments] = useState<ChatImageInput[]>([]);
  // M17-2: 自律モード(main側が正。イベントで同期し、ON操作は警告モーダルを必須にする)
  const [autonomous, setAutonomous] = useState(false);
  const [autoModal, setAutoModal] = useState(false);
  // M18: モデル自動切替が有効ならメイン応答に planner バッジを出す
  const [policyOn, setPolicyOn] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const busy = activeSessionId !== null;

  useEffect(() => {
    window.api
      .autonomousGet()
      .then((r) => setAutonomous(r.on))
      .catch(() => {});
    return window.api.onAutonomousChanged((p) => setAutonomous(p.on));
  }, []);

  // 設定変更(Settingsを閉じた後)を拾えるよう、アイドル復帰のたびに読み直す
  useEffect(() => {
    if (busy) return;
    window.api
      .settingsGet()
      .then((c) => setPolicyOn(c.modelPolicy?.enabled === true))
      .catch(() => {});
  }, [busy]);

  const addFiles = async (files: Iterable<File>): Promise<void> => {
    const added: ChatImageInput[] = [];
    for (const f of files) {
      const a = await fileToAttachment(f).catch(() => null);
      if (a) added.push(a);
    }
    if (added.length > 0) setAttachments((prev) => [...prev, ...added].slice(0, 8));
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);
  // セッション完了のたびに一覧を最新化(タイトル・更新時刻の反映)
  useEffect(() => {
    if (!busy) void refreshSessions();
  }, [busy, refreshSessions]);

  const submit = (): void => {
    if (busy) return;
    void send(input, planMode ? 'plan' : 'normal', attachments.length > 0 ? attachments : undefined);
    setInput('');
    setAttachments([]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {autonomous && (
        <div className="flex items-center justify-center gap-3 border-b border-amber-700 bg-amber-900/60 px-4 py-1.5 text-xs text-amber-200">
          <span>🔓 自律モード有効 — ツールを承認なしで自動実行中(自己責任)</span>
          <button
            className="rounded border border-amber-500 px-2 py-0.5 text-amber-100 hover:bg-amber-800"
            onClick={() => void window.api.autonomousSet(false)}
          >
            OFFにする
          </button>
        </div>
      )}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-1.5 text-xs">
        <select
          className="max-w-[320px] flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-300 disabled:opacity-40"
          value=""
          disabled={busy}
          onFocus={() => void refreshSessions()}
          onChange={(e) => {
            if (e.target.value) void loadSession(e.target.value);
          }}
        >
          <option value="">過去のセッションを開く…({sessions.length}件)</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title || '(無題)'} — {new Date(s.updatedAt).toLocaleString()}
            </option>
          ))}
        </select>
        <button
          className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          disabled={busy}
          onClick={() => void newSession()}
        >
          新規セッション
        </button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="mt-16 text-center text-sm text-zinc-500">
            指示を入力するとエージェントが作業を開始します(APIキーは設定パネルから登録)
          </p>
        )}
        {messages.map((m) =>
          m.role === 'tool' ? (
            <ToolCard key={m.id} msg={m} />
          ) : m.role === 'review' ? (
            <ReviewCard key={m.id} card={m} />
          ) : m.role === 'info' ? (
            <div key={m.id} className="anim-appear flex justify-center">
              <div className="max-w-[85%] rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-center text-[11px] text-zinc-400">
                ℹ️ {m.text}
              </div>
            </div>
          ) : (
            <div
              key={m.id}
              className={m.role === 'user' ? 'anim-appear flex justify-end' : 'anim-appear flex justify-start'}
            >
              <div
                className={
                  'max-w-[80%] rounded-lg px-3 py-2 text-sm ' +
                  (m.role === 'user' ? 'whitespace-pre-wrap bg-blue-600' : 'bg-zinc-800')
                }
              >
                {m.images && m.images.length > 0 && (
                  <div className="mb-1 flex flex-wrap gap-1">
                    {m.images.map((src, i) => (
                      <img
                        key={i}
                        src={src}
                        alt="添付画像"
                        className="max-h-40 max-w-[240px] rounded border border-blue-400/40 object-contain"
                      />
                    ))}
                  </div>
                )}
                {/* M18: policy有効時、メイン応答は planner 帯であることを小さく明示 */}
                {m.role === 'assistant' && policyOn && (
                  <div className="mb-0.5 text-[9px] uppercase tracking-wider text-zinc-500">planner</div>
                )}
                {m.role === 'assistant' ? <MarkdownMessage text={m.text} /> : m.text}
                {m.streaming && <span className="anim-pulse ml-1">▍</span>}
              </div>
            </div>
          ),
        )}
        <div ref={bottomRef} />
      </div>
      <div
        className="border-t border-zinc-700 p-3"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(e.dataTransfer.files);
        }}
      >
        {busy && (
          <p className="mb-1 text-xs text-zinc-500">
            状態: {status === 'calling_llm' ? 'モデル応答中' : status === 'executing_tool' ? 'ツール実行中' : status}
          </p>
        )}
        <div className="mb-2 flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1 text-zinc-400">
            <input type="checkbox" checked={planMode} onChange={(e) => setPlanMode(e.target.checked)} />
            プランモード(実装前に計画のみ提示・ツール不実行)
          </label>
          <span className="text-zinc-600">画像はドラッグ&ドロップ / ペーストで添付</span>
        </div>
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a, i) => (
              <div key={i} className="relative">
                <img
                  src={`data:${a.mediaType};base64,${a.data}`}
                  alt={a.description ?? '添付画像'}
                  className="h-16 w-16 rounded border border-zinc-700 object-cover"
                />
                <button
                  className="absolute -right-1.5 -top-1.5 h-4 w-4 rounded-full bg-zinc-700 text-[10px] leading-4 hover:bg-red-600"
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          {/* M17-2: 自律モードトグル(ONは警告モーダル必須・OFFはワンクリック) */}
          <button
            className={
              'shrink-0 self-end rounded-md border px-2 py-2 text-xs ' +
              (autonomous
                ? 'border-amber-500 bg-amber-900/50 text-amber-200 hover:bg-amber-800'
                : 'border-zinc-600 text-zinc-400 hover:bg-zinc-800')
            }
            title={autonomous ? '自律モードをOFFにする' : '自律モード(承認なし自動実行)をONにする'}
            onClick={() => {
              if (autonomous) void window.api.autonomousSet(false);
              else setAutoModal(true);
            }}
          >
            {autonomous ? '🔓 自律モード' : '🔒 通常'}
          </button>
          <textarea
            className="max-h-40 flex-1 resize-none rounded-md border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-blue-500"
            rows={2}
            placeholder="指示を入力(Enterで送信 / Shift+Enterで改行)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.items]
                .filter((it) => it.kind === 'file')
                .map((it) => it.getAsFile())
                .filter((f): f is File => f !== null);
              if (files.length > 0) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
          />
          {busy ? (
            <button
              className="rounded-md bg-red-600 px-4 text-sm hover:bg-red-500"
              onClick={cancel}
            >
              停止
            </button>
          ) : (
            <button
              className="rounded-md bg-blue-600 px-4 text-sm hover:bg-blue-500 disabled:opacity-40"
              disabled={!input.trim() && attachments.length === 0}
              onClick={submit}
            >
              送信
            </button>
          )}
        </div>
      </div>
      {autoModal && (
        <AutonomousModal
          onConfirm={() => {
            setAutoModal(false);
            void window.api.autonomousSet(true);
          }}
          onCancel={() => setAutoModal(false)}
        />
      )}
    </div>
  );
}
