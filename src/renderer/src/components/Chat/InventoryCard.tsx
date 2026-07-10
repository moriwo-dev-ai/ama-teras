import { useState } from 'react';
import type { ProvisionalInstall } from '../../../../shared/types';

/**
 * M29-5: 仮導入の棚卸しカード(自律実行の終了時に表示)。
 * 各項目に「残す」(確定)/「削除」(完全アンインストール=evolve/N のrevert)。
 * 未応答のまま閉じても仮導入は残り、進化タブの棚卸しセクションで次回も対応できる
 */
export function InventoryCard({ items }: { items: ProvisionalInstall[] }): JSX.Element {
  // jobId → 応答結果メッセージ(応答済み項目はボタンを消す)
  const [resolved, setResolved] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);

  const respond = (jobId: number, keep: boolean): void => {
    setBusy(jobId);
    void window.api
      .inventoryResolve(jobId, keep)
      .then((r) => setResolved((m) => ({ ...m, [jobId]: `${r.ok ? '✓' : '✗'} ${r.message}` })))
      .catch((err: unknown) =>
        setResolved((m) => ({ ...m, [jobId]: `✗ ${err instanceof Error ? err.message : String(err)}` })),
      )
      .finally(() => setBusy(null));
  };

  return (
    <div className="anim-appear rounded-lg border border-emerald-800 bg-emerald-950/40 p-3 text-xs">
      <p className="mb-2 font-semibold text-emerald-300">
        📦 仮導入の棚卸し — この作業で {items.length} 件のプラグインを仮導入しました
      </p>
      <ul className="space-y-1.5">
        {items.map((p) => (
          <li key={p.jobId} className="flex flex-wrap items-center gap-2 rounded border border-zinc-700 bg-zinc-900 px-2 py-1">
            <span className="font-mono text-emerald-300">{p.toolName}</span>
            <span className="shrink-0 rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">
              {p.origin === 'registry' ? 'コミュニティ(検証済み)' : '自己生成'}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-zinc-500">{p.tag}</span>
            {resolved[p.jobId] !== undefined ? (
              <span className="min-w-0 flex-1 text-zinc-300">{resolved[p.jobId]}</span>
            ) : (
              <span className="ml-auto flex shrink-0 gap-1.5">
                <button
                  className="whitespace-nowrap rounded bg-emerald-700 px-2 py-0.5 text-[11px] hover:bg-emerald-600 disabled:opacity-40"
                  disabled={busy !== null}
                  onClick={() => respond(p.jobId, true)}
                >
                  残す
                </button>
                <button
                  className="whitespace-nowrap rounded border border-red-800 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-950 disabled:opacity-40"
                  disabled={busy !== null}
                  title="完全アンインストール(昇格をrevertする)"
                  onClick={() => respond(p.jobId, false)}
                >
                  削除
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-zinc-500">
        未応答の項目は仮導入のまま残り、進化タブの「仮導入の棚卸し」から後でも対応できます
      </p>
    </div>
  );
}
