import { existsSync } from 'node:fs';
import { symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
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
