import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceGitStatus } from '../../../../shared/types';
import { useChatStore } from '../../stores/chat';
import { parsePlanProgress } from '../Plan/planParse';

/**
 * M15-4: 環境ウィジェット。workspace / gitブランチ / 未コミット数 / チェックポイント数 / 計画進捗。
 * git無しworkspaceではgit行は非表示。ターン完了ごとに自動更新。
 */
export function EnvWidget(): JSX.Element {
  const busy = useChatStore((s) => s.activeSessionId !== null);
  const [ws, setWs] = useState('');
  const [git, setGit] = useState<WorkspaceGitStatus | null>(null);
  const [checkpoints, setCheckpoints] = useState<number | null>(null);
  const [plan, setPlan] = useState<{ done: number; total: number } | null>(null);
  // M26-7: 「この会話を移動」— 選択済みの移動先(確認待ち)と結果メッセージ
  const [movePending, setMovePending] = useState<string | null>(null);
  const [moveMsg, setMoveMsg] = useState('');

  const refresh = useCallback(async () => {
    try {
      const cfg = await window.api.settingsGet();
      setWs(cfg.workspace ?? '');
      const [g, ckpts, planText] = await Promise.all([
        window.api.workspaceGitStatus(),
        window.api.checkpointList().catch(() => []),
        window.api.planGet().catch(() => ''),
      ]);
      setGit(g);
      setCheckpoints(ckpts.length);
      const progress = parsePlanProgress(planText);
      setPlan(progress.total > 0 ? { done: progress.done, total: progress.total } : null);
    } catch {
      /* ウィジェットは情報表示のみ */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!busy) void refresh();
  }, [busy, refresh]);

  const wsName = ws === '' ? '(既定)' : ws.split(/[\\/]/).filter(Boolean).pop();

  return (
    <div className="space-y-0.5 border-b border-zinc-800 px-3 py-2 text-[11px] text-zinc-400">
      <div className="flex items-center gap-1">
        <span className="truncate font-mono text-zinc-300" title={ws || '(既定workspace)'}>
          📁 {wsName}
        </span>
        {/* M26-7: 表示中の会話のworkspaceを移動(実行中はmain側でも拒否されるがUIでも防ぐ) */}
        <button
          className="ml-auto rounded border border-zinc-800 px-1 text-[10px] text-zinc-500 hover:bg-zinc-800 disabled:opacity-40"
          disabled={busy}
          title="この会話の作業ディレクトリを別の場所へ移動する(以降のツール実行が移動先を参照)"
          onClick={async () => {
            setMoveMsg('');
            const picked = await window.api.pickWorkspace();
            if (picked) setMovePending(picked);
          }}
        >
          移動
        </button>
        <button
          className="rounded border border-zinc-800 px-1 text-[10px] text-zinc-500 hover:bg-zinc-800"
          onClick={() => void refresh()}
        >
          更新
        </button>
      </div>
      {movePending !== null && (
        <div className="rounded border border-amber-700 bg-amber-950 px-1.5 py-1">
          <p className="break-all text-amber-300">
            この会話を <span className="font-mono">{movePending}</span> へ移動する?
            以降のツール実行・チェックポイント・計画はこちらを参照する
          </p>
          <div className="mt-0.5 flex gap-1">
            <button
              className="rounded bg-amber-700 px-1.5 py-0.5 text-[10px] hover:bg-amber-600"
              onClick={async () => {
                const r = await window.api.conversationMoveWorkspace(movePending);
                setMovePending(null);
                setMoveMsg(r.ok ? `移動した: ${r.message}` : `移動できない: ${r.message}`);
                if (r.ok) void refresh();
              }}
            >
              移動する
            </button>
            <button
              className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
              onClick={() => setMovePending(null)}
            >
              取消
            </button>
          </div>
        </div>
      )}
      {moveMsg !== '' && <p className="break-all text-amber-300">{moveMsg}</p>}
      {git?.isGit && (
        <div>
          ⎇ {git.branch}
          {git.dirtyCount !== undefined && git.dirtyCount > 0 && (
            <span className="ml-1 text-amber-400">±{git.dirtyCount}</span>
          )}
          {checkpoints !== null && checkpoints > 0 && (
            <span className="ml-2 text-zinc-500">⏱ checkpoint {checkpoints}</span>
          )}
        </div>
      )}
      {plan && (
        <div className="text-emerald-400">
          ☑ 計画 {plan.done}/{plan.total}
        </div>
      )}
    </div>
  );
}
