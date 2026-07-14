import type { EvolutionJobStatus } from './types';

/**
 * M79: 進化タブのバッジが「通知1」を出し続けていた。中身は**完了済み**のジョブ1件。
 * RightPane が終端状態を文字列リテラルの集合で持っていて、その中身が
 * `['promoted', 'failed', 'rejected', 'rolled_back']` — **'promoted' という状態は存在せず**、
 * 実際の完了状態 'done' と 'cancelled' が漏れていた。結果、終わったジョブが永久に
 * 「進行中」として数えられる。文字列の集合は型が増減しても黙って壊れるので、
 * ここで **EvolutionJobStatus を網羅した表**にする(欠けると typecheck が落ちる)。
 *
 * バッジ = 「まだこちらの手が要る」もの。動いている最中 + 昇格承認待ち。
 */
const ACTIVE: Record<EvolutionJobStatus, boolean> = {
  queued: true,
  preparing_worktree: true,
  generating: true,
  verifying: true,
  awaiting_promotion: true, // 全ゲート通過。ユーザーの承認を待っている(=見に行く価値がある)
  promoting: true,
  done: false,
  failed: false,
  rejected: false,
  cancelled: false,
  rolled_back: false,
};

export function isJobActive(status: EvolutionJobStatus): boolean {
  return ACTIVE[status] ?? false;
}
