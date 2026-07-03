import { useEffect, useState } from 'react';
import type { EvolutionJobStatus } from '../../../../shared/types';
import { useEvolutionStore } from '../../stores/evolution';

const STATUS_LABEL: Record<EvolutionJobStatus, { text: string; cls: string }> = {
  queued: { text: '待機中', cls: 'text-zinc-400' },
  preparing_worktree: { text: 'B環境準備中', cls: 'text-blue-300' },
  generating: { text: '生成中', cls: 'text-blue-300' },
  verifying: { text: '検証中', cls: 'text-amber-300' },
  awaiting_promotion: { text: '昇格承認待ち', cls: 'text-amber-300' },
  promoting: { text: '昇格中', cls: 'text-blue-300' },
  done: { text: '完了', cls: 'text-green-400' },
  failed: { text: '失敗', cls: 'text-red-400' },
  rejected: { text: '却下', cls: 'text-zinc-400' },
  rolled_back: { text: 'ロールバック済み', cls: 'text-red-400' },
};

export function EvolutionPanel(): JSX.Element {
  const { jobs, loadJobs } = useEvolutionStore();
  const [desc, setDesc] = useState('');
  const [io, setIo] = useState('');
  const [openLog, setOpenLog] = useState<number | null>(null);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  return (
    <div className="space-y-2 border-t border-zinc-700 bg-zinc-950 p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-zinc-400">進化ジョブ</span>
        <input
          className="flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs"
          placeholder="必要な能力の説明(手動起動・デバッグ用)"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
        <input
          className="w-64 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs"
          placeholder="期待する入出力"
          value={io}
          onChange={(e) => setIo(e.target.value)}
        />
        <button
          className="rounded bg-purple-700 px-3 py-1 text-xs hover:bg-purple-600 disabled:opacity-40"
          disabled={!desc.trim()}
          onClick={() => {
            void window.api.evolutionEnqueue(desc, io || '(指定なし)');
            setDesc('');
            setIo('');
          }}
        >
          ジョブ起動
        </button>
      </div>
      {jobs.length === 0 && <p className="text-xs text-zinc-500">ジョブはまだない</p>}
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {jobs.map((j) => (
          <div key={j.id} className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-mono text-zinc-400">#{j.id}</span>
              <span className="truncate">{j.description}</span>
              {j.toolName && <span className="font-mono text-blue-300">{j.toolName}</span>}
              <span className={`ml-auto ${STATUS_LABEL[j.status].cls}`}>{STATUS_LABEL[j.status].text}</span>
              <button
                className="text-zinc-500 hover:text-zinc-300"
                onClick={() => setOpenLog(openLog === j.id ? null : j.id)}
              >
                {openLog === j.id ? '▲' : '▼'}
              </button>
            </div>
            {openLog === j.id && (
              <div className="mt-1 space-y-1 border-t border-zinc-700 pt-1 text-zinc-400">
                {j.error && <p className="text-red-400">エラー: {j.error}</p>}
                {j.gates.map((g) => (
                  <p key={g.name}>
                    {g.ok ? '✓' : '✗'} {g.name}: {g.detail.slice(0, 300)}
                  </p>
                ))}
                {j.log.map((l, i) => (
                  <p key={i} className="font-mono">{l}</p>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function PromotionDialog(): JSX.Element | null {
  const { promotion, respondPromotion } = useEvolutionStore();
  if (!promotion) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[720px] max-w-[95vw] rounded-lg border border-purple-700 bg-zinc-900 p-4 shadow-xl">
        <h2 className="mb-2 text-sm font-semibold">
          進化ジョブ #{promotion.jobId} の昇格承認:{' '}
          <code className="text-purple-300">{promotion.toolName}</code>
        </h2>
        <p className="mb-2 text-xs text-zinc-400">
          検証ゲート(差分検査 / typecheck / vitest / スモーク)は全合格。mainブランチへマージして
          稼働中のアプリに動的ロードする。
        </p>
        {promotion.warnings.length > 0 && (
          <div className="mb-2 rounded-md border border-red-700 bg-red-950 p-2 text-xs text-red-300">
            {promotion.warnings.map((w, i) => (
              <div key={i}>⚠ {w}</div>
            ))}
          </div>
        )}
        <pre className="mb-3 max-h-72 overflow-auto rounded-md border border-zinc-700 bg-zinc-950 p-2 text-xs leading-5 text-zinc-300">
          {promotion.diff}
        </pre>
        <div className="flex justify-end gap-2">
          <button
            className="rounded-md border border-zinc-600 px-4 py-1.5 text-sm hover:bg-zinc-800"
            onClick={() => respondPromotion(false)}
          >
            却下
          </button>
          <button
            className="rounded-md bg-purple-700 px-4 py-1.5 text-sm hover:bg-purple-600"
            onClick={() => respondPromotion(true)}
          >
            昇格を承認
          </button>
        </div>
      </div>
    </div>
  );
}
