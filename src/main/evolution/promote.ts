import { runGit } from './git';

export interface PromotionResult {
  mergeCommit: string;
  tag: string;
}

/**
 * 昇格の事前条件を検査する。承認ダイアログを出す前に呼び、doomed な昇格で
 * ユーザーを煩わせない/承認後に落ちるUX破綻を避けるため fail-fast させる。
 * A のチェックアウトが baseRef であることのみ要求する(未コミットの無関係な変更は許容)。
 */
export async function assertPromotable(repoDir: string, baseRef: string): Promise<void> {
  const current = await runGit(['branch', '--show-current'], repoDir);
  if (current !== baseRef) {
    throw new Error(
      `Aのチェックアウトが ${baseRef} ではない(現在: ${current || 'detached HEAD'})。昇格できない`,
    );
  }
}

/**
 * 昇格(B→A): baseRef へ --no-ff マージし evolve/N タグを打つ。呼び出し前にユーザー承認済みであること。
 * 未コミットの無関係な変更(PROGRESS.md 等)があってもマージが触れなければ成功する。
 * マージが衝突・競合した場合は merge --abort で巻き戻し、MERGE_HEAD を残さない。
 */
export async function promoteBranch(
  repoDir: string,
  branch: string,
  jobId: number,
  baseRef: string,
): Promise<PromotionResult> {
  await assertPromotable(repoDir, baseRef);
  try {
    await runGit(['merge', '--no-ff', branch, '-m', `evolve: job-${jobId} を昇格`], repoDir);
  } catch (err) {
    // 衝突・作業ツリー競合で中断した場合、半マージ状態(MERGE_HEAD)を残さず巻き戻す
    await runGit(['merge', '--abort'], repoDir).catch(() => {});
    throw new Error(
      `昇格マージに失敗(ロールバック済み): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const mergeCommit = await runGit(['rev-parse', 'HEAD'], repoDir);
  const tag = `evolve/${jobId}`;
  await runGit(['tag', tag, mergeCommit], repoDir);
  return { mergeCommit, tag };
}

/** ロールバック: 昇格マージコミットをrevertして直前タグ状態へ戻す(履歴は残す) */
export async function rollbackMerge(repoDir: string, mergeCommit: string): Promise<string> {
  await runGit(['revert', '-m', '1', '--no-edit', mergeCommit], repoDir);
  return runGit(['rev-parse', 'HEAD'], repoDir);
}

/** 既存の evolve/N タグから次のジョブIDを決める */
export async function nextJobId(repoDir: string): Promise<number> {
  const out = await runGit(['tag', '-l', 'evolve/*'], repoDir).catch(() => '');
  const ids = out
    .split('\n')
    .map((t) => Number.parseInt(t.replace('evolve/', ''), 10))
    .filter((n) => Number.isInteger(n));
  return ids.length === 0 ? 1 : Math.max(...ids) + 1;
}
