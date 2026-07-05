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
        <button
          className="ml-auto rounded border border-zinc-800 px-1 text-[10px] text-zinc-500 hover:bg-zinc-800"
          onClick={() => void refresh()}
        >
          更新
        </button>
      </div>
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
