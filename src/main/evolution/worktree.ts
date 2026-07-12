import { existsSync } from 'node:fs';
import { readdir, symlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runGit } from './git';

export interface WorktreeInfo {
  dir: string;
  branch: string;
}

/**
 * B環境(進化用worktree)の作成と破棄。A(稼働中checkout)には触らない。
 * node_modules はジャンクションでAと共有(依存追加を要するジョブはfail方針)。
 */
export class WorktreeManager {
  constructor(
    private readonly repoDir: string,
    private readonly worktreeBase: string,
    /** 「中身が無い残骸ブランチ」の判定基準(これと同一なら生成物ゼロ) */
    private readonly baseRef: string = 'main',
  ) {}

  async create(jobId: number, baseRef: string): Promise<WorktreeInfo> {
    const branch = `evolve/job-${jobId}`;
    const dir = join(this.worktreeBase, `job-${jobId}`);
    await runGit(['worktree', 'add', dir, '-b', branch, baseRef], this.repoDir);

    const sourceModules = join(this.repoDir, 'node_modules');
    const targetModules = join(dir, 'node_modules');
    if (existsSync(sourceModules) && !existsSync(targetModules)) {
      // Windowsでは管理者権限不要のjunctionを使う
      await symlink(sourceModules, targetModules, 'junction');
    }
    return { dir, branch };
  }

  /**
   * M50: 前回の残骸(B環境)を掃除する。**起動直後、ジョブが1件も走っていない時にだけ呼ぶ**。
   *
   * remove() はジョブの後始末でしか呼ばれないので、taskkill・クラッシュ・電源断では走らない。
   * worktreeとブランチが残り、次の起動でIDが再採番されて同じ名前にぶつかると、
   * `worktree add` が `already exists` で落ちてジョブが即死する(実害: ジョブ14・15)。
   *
   * 消すのは **worktreeとディレクトリだけ**。中身を持つブランチは残す —
   * 実際に落ちたジョブ14・15のブランチには生成済みのプラグインが2試行分入っていた。
   * 検証を通っていない=使い捨て、と決めつけて消すと、ユーザーが後から
   * `git log evolve/job-N` で拾い直す道まで閉じる。衝突を避けるのは掃除ではなく
   * **採番(nextJobId)の仕事**で、そちらが既にブランチを見ている。
   * 中身が無い(mainと同一の)ブランチだけは、ただのゴミなので消す。
   * A(稼働中のcheckout)は worktreeBase の外なので絶対に触らない。
   */
  async sweepStale(): Promise<string[]> {
    const swept: string[] = [];
    const list = await runGit(['worktree', 'list', '--porcelain'], this.repoDir).catch(() => '');
    for (const line of list.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const dir = line.slice('worktree '.length).trim();
      if (!this.isBEnv(dir)) continue;
      await this.removeDir(dir);
      swept.push(dir);
    }
    await runGit(['worktree', 'prune'], this.repoDir).catch(() => {});

    // worktreeとして登録されていない残骸ディレクトリ(prune済み・登録前に落ちた等)
    if (existsSync(this.worktreeBase)) {
      const names = await readdir(this.worktreeBase).catch(() => [] as string[]);
      for (const name of names) {
        if (!name.startsWith('job-')) continue;
        const dir = join(this.worktreeBase, name);
        if (swept.includes(dir)) continue;
        await this.removeDir(dir);
        swept.push(dir);
      }
    }

    const branches = await runGit(['branch', '--list', 'evolve/job-*'], this.repoDir).catch(
      () => '',
    );
    for (const raw of branches.split('\n')) {
      const branch = raw.replace(/^[*+\s]+/, '').trim();
      if (branch === '') continue;
      const commits = await runGit(
        ['rev-list', '--count', `${this.baseRef}..${branch}`],
        this.repoDir,
      ).catch(() => '1'); // 数えられないなら「中身あり」側に倒す(消さない)
      if (commits.trim() !== '0') continue; // 生成物が入っている = 残す
      await runGit(['branch', '-D', branch], this.repoDir).catch(() => {});
      swept.push(branch);
    }
    return swept;
  }

  /** worktreeBase の中か。A(稼働中checkout)を消さないための境界 */
  private isBEnv(dir: string): boolean {
    const norm = (p: string): string => resolve(p).replace(/\\/g, '/').toLowerCase();
    return norm(dir).startsWith(`${norm(this.worktreeBase)}/`);
  }

  /** node_modules のジャンクションを先に外してからディレクトリごと消す(Aの実体を辿らせない) */
  private async removeDir(dir: string): Promise<void> {
    await rm(join(dir, 'node_modules'), { force: true, recursive: false }).catch(() => {});
    await runGit(['worktree', 'remove', '--force', dir], this.repoDir).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  /** worktreeとブランチを破棄する。昇格済みブランチはマージ済みなので -D で問題ない */
  async remove(info: WorktreeInfo): Promise<void> {
    // ジャンクションを先に外す(git worktree remove がリンク先を辿らないように)
    await rm(join(info.dir, 'node_modules'), { force: true, recursive: false }).catch(() => {});
    await runGit(['worktree', 'remove', '--force', info.dir], this.repoDir).catch(async () => {
      await rm(info.dir, { recursive: true, force: true });
      await runGit(['worktree', 'prune'], this.repoDir).catch(() => {});
    });
    await runGit(['branch', '-D', info.branch], this.repoDir).catch(() => {});
  }
}
