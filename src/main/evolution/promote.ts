import { runGit } from './git';

export interface PromotionResult {
  mergeCommit: string;
  tag: string;
}

/** 昇格(B→A): mainへ --no-ff マージし evolve/N タグを打つ。呼び出し前にユーザー承認済みであること */
export async function promoteBranch(
  repoDir: string,
  branch: string,
  jobId: number,
  baseRef: string,
): Promise<PromotionResult> {
  const current = await runGit(['branch', '--show-current'], repoDir);
  if (current !== baseRef) {
    throw new Error(`Aのチェックアウトが ${baseRef} ではない(現在: ${current})。昇格を中止`);
  }
  const dirty = await runGit(['status', '--porcelain'], repoDir);
  if (dirty !== '') {
    throw new Error('Aに未コミットの変更がある。昇格を中止');
  }
  await runGit(['merge', '--no-ff', branch, '-m', `evolve: job-${jobId} を昇格`], repoDir);
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
