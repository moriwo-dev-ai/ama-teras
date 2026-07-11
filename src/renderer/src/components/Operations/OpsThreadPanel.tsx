import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalBatch, OpsThreadMessage } from '../../../../shared/types';
import { useOpsThreadStore } from '../../stores/opsThread';

/**
 * M33-4: ⛩ 運営スレッド — ユーザーと神議の会話場所(1本固定・通常チャットと混ぜない)。
 * 神議の分析・承認バッチはここへカードで届く。右ペイン運営タブはダッシュボード専用。
 */

function BatchCard({ batch, onRespond }: { batch: ApprovalBatch; onRespond: () => void }): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const kindLabel = { 'exec-action': '実行提案', 'param-approval': 'パラメータ承認', 'capability-gap': '能力ギャップ' } as const;
  return (
    <div className="rounded-md border border-orange-800 bg-zinc-950 p-2 text-xs">
      <p className="mb-1 font-semibold text-orange-300">⛩ 承認バッチ({batch.ts.slice(5, 16)})</p>
      <div className="space-y-1.5">
        {batch.items.map((item) => (
          <div key={item.id} className="rounded border border-zinc-800 p-1.5">
            <div className="mb-0.5 flex items-center gap-1.5">
              <span className="rounded bg-zinc-700 px-1 py-0.5 text-[10px]">{kindLabel[item.kind]}</span>
              <span className="min-w-0 flex-1 font-semibold text-zinc-200">{item.title}</span>
            </div>
            <p className="mb-1 whitespace-pre-wrap text-zinc-400">{item.detail}</p>
            {item.status === 'pending' ? (
              <div className="flex gap-1.5">
                <button
                  className="rounded border border-green-800 px-2 py-0.5 text-[10px] text-green-300 hover:bg-green-950 disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy(item.id);
                    void window.api
                      .operationsBatchRespond(batch.id, item.id, true)
                      .then((r) => setNotice(r.detail))
                      .finally(() => {
                        setBusy(null);
                        onRespond();
                      });
                  }}
                >
                  承認
                </button>
                <button
                  className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy(item.id);
                    void window.api
                      .operationsBatchRespond(batch.id, item.id, false)
                      .finally(() => {
                        setBusy(null);
                        onRespond();
                      });
                  }}
                >
                  却下
                </button>
              </div>
            ) : (
              <span className={`text-[10px] ${item.status === 'approved' ? 'text-green-400' : 'text-zinc-500'}`}>
                {item.status === 'approved' ? '✓ 承認済み' : '✗ 却下'}
              </span>
            )}
          </div>
        ))}
      </div>
      {notice !== null && <p className="mt-1 text-[10px] text-zinc-400">{notice}</p>}
      <p className="mt-1 text-[10px] text-zinc-600">実行系の承認後も、実発行は岩戸ゲート(最終確認ダイアログ)を通る</p>
    </div>
  );
}

export function OpsThreadPanel(): JSX.Element {
  const [messages, setMessages] = useState<OpsThreadMessage[]>([]);
  const [batches, setBatches] = useState<Map<string, ApprovalBatch>>(new Map());
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const refreshPending = useOpsThreadStore((s) => s.refreshPending);
  const bottomRef = useRef<HTMLDivElement>(null);

  const reload = useCallback((): void => {
    void window.api.operationsThreadList().then(setMessages);
    void window.api.operationsThreadBatches().then((list) => setBatches(new Map(list.map((b) => [b.id, b]))));
    void refreshPending();
  }, [refreshPending]);

  useEffect(() => {
    reload();
    const timer = setInterval(reload, 30_000); // 神議の定刻投函を拾う
    return () => clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = (): void => {
    const text = input.trim();
    if (text === '' || busy !== null) return;
    setInput('');
    setBusy('send');
    void window.api
      .operationsThreadSend(text)
      .then(setMessages)
      .finally(() => setBusy(null));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <h2 className="text-sm font-semibold text-zinc-100">⛩ 運営 — Project TAKAMA-gahara</h2>
        <span className="text-[10px] text-zinc-500">神議との会話・承認バッチ(通常の作業会話とは別)</span>
        <button
          className="ml-auto rounded border border-zinc-600 px-2 py-0.5 text-xs hover:bg-zinc-800 disabled:opacity-50"
          disabled={busy !== null}
          title="定刻(朝9時・夜21時)を待たずに神議を1回開く(planner帯を消費)"
          onClick={() => {
            setBusy('kamuhakari');
            void window.api.operationsKamuhakariRun().finally(() => {
              setBusy(null);
              reload();
            });
          }}
        >
          {busy === 'kamuhakari' ? '神議中…' : '🧠 神議を今すぐ開く'}
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {messages.length === 0 && (
          <p className="text-xs text-zinc-500">
            まだ何もない。神議は朝9時・夜21時に自動で開かれ、分析と承認バッチがここへ届く。
            相談・指示(「キーワードを変えて」等)もここに書けば神議が拾う
          </p>
        )}
        {messages.map((m) => {
          if (m.kind === 'approval-batch' && m.batchId !== undefined) {
            const batch = batches.get(m.batchId);
            return batch ? <BatchCard key={m.id} batch={batch} onRespond={reload} /> : null;
          }
          const align = m.role === 'user' ? 'ml-8' : 'mr-8';
          const border = m.role === 'user' ? 'border-blue-900' : m.kind === 'notice' ? 'border-amber-900' : 'border-zinc-800';
          return (
            <div key={m.id} className={`rounded-md border ${border} bg-zinc-950 p-2 text-xs ${align}`}>
              <p className="mb-0.5 text-[10px] text-zinc-500">
                {m.role === 'user' ? 'あなた' : m.role === 'kamuhakari' ? '🧠 神議' : '⚙ system'} ・ {m.ts.slice(5, 16)}
              </p>
              <p className="whitespace-pre-wrap text-zinc-200">{m.body}</p>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="flex gap-2 border-t border-zinc-800 p-2">
        <input
          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs"
          placeholder="神議への相談・指示(Enterで送信)"
          value={input}
          disabled={busy !== null}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) send();
          }}
        />
        <button
          className="shrink-0 rounded bg-blue-600 px-3 py-1.5 text-xs hover:bg-blue-500 disabled:opacity-50"
          disabled={busy !== null || input.trim() === ''}
          onClick={send}
        >
          {busy === 'send' ? '…' : '送信'}
        </button>
      </div>
    </div>
  );
}
