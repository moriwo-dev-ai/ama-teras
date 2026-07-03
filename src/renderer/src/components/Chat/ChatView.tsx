import { useEffect, useRef, useState } from 'react';
import { useChatStore, type UiMessage } from '../../stores/chat';

function ToolCard({ msg }: { msg: Extract<UiMessage, { role: 'tool' }> }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex justify-start">
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
          {msg.running && <span className="animate-pulse text-zinc-400">実行中…</span>}
          {!msg.running && <span className="text-zinc-500">{open ? '▲' : '▼'}</span>}
        </button>
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
  const { messages, status, activeSessionId, send, cancel } = useChatStore();
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const busy = activeSessionId !== null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const submit = (): void => {
    if (busy) return;
    void send(input);
    setInput('');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="mt-16 text-center text-sm text-zinc-500">
            指示を入力するとエージェントが作業を開始します(APIキーは設定パネルから登録)
          </p>
        )}
        {messages.map((m) =>
          m.role === 'tool' ? (
            <ToolCard key={m.id} msg={m} />
          ) : (
            <div
              key={m.id}
              className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
            >
              <div
                className={
                  'max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ' +
                  (m.role === 'user' ? 'bg-blue-600' : 'bg-zinc-800')
                }
              >
                {m.text}
                {m.streaming && <span className="ml-1 animate-pulse">▍</span>}
              </div>
            </div>
          ),
        )}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-zinc-700 p-3">
        {busy && (
          <p className="mb-1 text-xs text-zinc-500">
            状態: {status === 'calling_llm' ? 'モデル応答中' : status === 'executing_tool' ? 'ツール実行中' : status}
          </p>
        )}
        <div className="flex gap-2">
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
              disabled={!input.trim()}
              onClick={submit}
            >
              送信
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
