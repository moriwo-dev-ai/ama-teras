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

/**
 * M99: 「⛩ 公開」ボタンを出してよいジョブか。
 *
 * 実機で ordinal_suffix / to_base64 の公開が「ソースが見つからない」で必ず失敗していた。
 * 原因は **夜間自動昇格(A6-2)** — auto ジョブは専用ブランチ(evolve/nightly)に積むだけで
 * main には入れない設計なのに、UI は status='done' だけを見て公開ボタンを出していた。
 * 手元(main)にソースが無いので、押せば100%失敗する。押させない。
 *
 * デスクトップ・スマホの2箇所で同じ条件を書いていて片方だけ直す事故が続いたので、
 * 判定はここに1本化する。
 */
export function isPublishableJob(job: {
  status: EvolutionJobStatus;
  scope?: 'tool' | 'renderer' | 'core';
  toolName?: string;
  autoBranch?: string;
}): boolean {
  return (
    job.status === 'done' &&
    job.scope !== 'renderer' &&
    job.scope !== 'core' &&
    job.toolName !== undefined &&
    job.autoBranch === undefined
  );
}
