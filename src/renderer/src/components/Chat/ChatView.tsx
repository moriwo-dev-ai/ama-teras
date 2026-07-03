import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../../stores/chat';

export function ChatView(): JSX.Element {
  const { messages, activeSessionId, send, cancel } = useChatStore();
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
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="mt-16 text-center text-sm text-zinc-500">
            メッセージを送るとエコー応答が返ります(M1: IPC疎通確認)
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
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
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-zinc-700 p-3">
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
