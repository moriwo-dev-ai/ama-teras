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

/** M20: ロールバック履歴用の evolve タグ情報 */
export interface EvolveTagInfo {
  tag: string;
  commit: string;
  date: string;
  subject: string;
}

/** M20: evolve/N タグの一覧(新しい順)。ロールバック履歴UIに使う */
export async function listEvolveTags(repoDir: string): Promise<EvolveTagInfo[]> {
  const out = await runGit(
    [
      'tag', '-l', 'evolve/*', '--sort=-creatordate',
      '--format=%(refname:short)\t%(objectname:short)\t%(creatordate:iso8601)\t%(subject)',
    ],
    repoDir,
  ).catch(() => '');
  if (out === '') return [];
  return out.split('\n').map((line) => {
    const [tag = '', commit = '', date = '', ...rest] = line.split('\t');
    return { tag, commit, date, subject: rest.join('\t') };
  });
}

/** M23-6: 進化で獲得した能力(スキル/自己書き換え)の一覧項目 */
export interface EvolvedCapability extends EvolveTagInfo {
  /** tool=プラグイン追加 / renderer=UI自己書き換え / core=本体ロジック自己書き換え */
  kind: 'tool' | 'renderer' | 'core';
  /** 追加/変更されたツールプラグイン名(plugins配下のファイル名由来) */
  toolNames: string[];
  /** この昇格で変更されたファイル(テスト含む) */
  files: string[];
}

/**
 * M23-6: 進化の昇格ごとに「何が獲得されたか」を導出する。
 * 変更ファイルはマージコミットの第1親(=昇格前のmain)との差分から取る
 */
export async function listEvolvedCapabilities(repoDir: string): Promise<EvolvedCapability[]> {
  const tags = await listEvolveTags(repoDir);
  const result: EvolvedCapability[] = [];
  for (const t of tags) {
    const out = await runGit(
      ['diff', '--name-only', '--no-renames', `${t.tag}^1`, t.tag],
      repoDir,
    ).catch(() => '');
    const files = out === '' ? [] : out.split('\n').filter((f) => f.trim() !== '');
    const norm = files.map((f) => f.replace(/\\/g, '/'));
    const toolNames = [
      ...new Set(
        norm
          .filter((f) => f.startsWith('src/main/tools/plugins/') && f.endsWith('.ts') && !f.endsWith('.test.ts'))
          .map((f) => f.split('/').pop()!.replace(/\.ts$/, '')),
      ),
    ];
    // 判定はコア寄りを優先(plugins/renderer以外のsrcに触れていればcore=本体の自己書き換え)
    const touchesCore = norm.some(
      (f) =>
        (f.startsWith('src/main/') || f.startsWith('src/shared/') || f.startsWith('src/preload/')) &&
        !f.startsWith('src/main/tools/plugins/'),
    );
    const touchesRenderer = norm.some((f) => f.startsWith('src/renderer/') || f.startsWith('src/remote-ui/'));
    const kind: EvolvedCapability['kind'] = touchesCore ? 'core' : touchesRenderer ? 'renderer' : 'tool';
    result.push({ ...t, kind, toolNames, files: norm });
  }
  return result;
}

/**
 * M20: 「1つ前へ戻す」— HEAD が最新 evolve タグのマージコミットと一致する場合のみ
 * revert する(履歴は残す)。一致しない(昇格後に別コミットが積まれた)場合は
 * 誤爆を避けて手動手順を案内する
 */
export async function rollbackLastEvolve(
  repoDir: string,
): Promise<{ ok: boolean; message: string; tag?: string }> {
  const tags = await listEvolveTags(repoDir);
  const latest = tags[0];
  if (!latest) return { ok: false, message: 'evolve タグが無い(戻す対象なし)' };
  const head = await runGit(['rev-parse', 'HEAD'], repoDir);
  const tagCommit = await runGit(['rev-parse', `${latest.tag}^{commit}`], repoDir);
  if (head !== tagCommit) {
    return {
      ok: false,
      message:
        `HEAD が最新の ${latest.tag} と一致しない(昇格後に別のコミットあり)。` +
        `誤爆を避けるため自動では戻さない。手動: git revert -m 1 ${tagCommit.slice(0, 8)}`,
    };
  }
  await runGit(['revert', '-m', '1', '--no-edit', tagCommit], repoDir);
  return { ok: true, message: `${latest.tag} を revert した`, tag: latest.tag };
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
