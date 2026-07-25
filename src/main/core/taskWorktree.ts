import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * M108: 一般タスク用のworktree隔離。進化サブシステム(聖域)のB環境と同じ原理を
 * タスクに使う — **本体(A)のcheckoutには一切触れず**、隔離コピーで作業し、
 * 結果はdiffとして提示、取り込みだけが承認制。
 *
 * 進化の WorktreeManager(src/main/evolution/worktree.ts)とは意図的に共有しない:
 * あちらは聖域(保護領域)で、リファクタの巻き込み事故の方が重複30行より高くつく。
 * ブランチ接頭辞も分ける(evolve/job-* と task/*)ので掃除・採番も干渉しない。
 */

export interface TaskWorktreeInfo {
  id: number;
  dir: string;
  branch: string;
}

async function runGitCmd(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export class TaskWorktreeManager {
  private readonly base: string;

  constructor(
    private readonly repoDir: string,
    baseDir?: string,
    private readonly git: (args: string[], cwd: string) => Promise<string> = runGitCmd,
  ) {
    // 既定はリポジトリの隣(amateras-evolve と同じ流儀)。リポジトリ内に作ると
    // 自分自身がdiffのノイズになる
    this.base = baseDir ?? join(repoDir, '..', `amateras-tasks-${basename(repoDir)}`);
  }

  /** workspaceがgitリポジトリか(worktreeの前提条件) */
  async isGitRepo(): Promise<boolean> {
    try {
      const out = await this.git(['rev-parse', '--is-inside-work-tree'], this.repoDir);
      return out.trim() === 'true';
    } catch {
      return false;
    }
  }

  async create(id: number): Promise<TaskWorktreeInfo> {
    if (!(await this.isGitRepo())) {
      throw new Error(`ワークスペースがgitリポジトリではないため、バックグラウンドタスクは使えない: ${this.repoDir}`);
    }
    const branch = `task/${id}`;
    const dir = join(this.base, `task-${id}`);
    // 残骸との衝突は先に掃除(taskブランチは使い捨て。evolve/* と違い生成物の救出対象ではない)
    await this.git(['worktree', 'remove', '--force', dir], this.repoDir).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await this.git(['branch', '-D', branch], this.repoDir).catch(() => {});
    await this.git(['worktree', 'add', dir, '-b', branch, 'HEAD'], this.repoDir);
    // node_modules をジャンクション共有(進化B環境と同じ。無ければ何もしない)
    const src = join(this.repoDir, 'node_modules');
    const dst = join(dir, 'node_modules');
    if (existsSync(src) && !existsSync(dst)) {
      await symlink(src, dst, 'junction').catch(() => {});
    }
    return { id, dir, branch };
  }

  /** worktree内の全変更(未追跡含む)をpatch形式で返す。変更なしは空文字 */
  async diff(info: TaskWorktreeInfo): Promise<string> {
    // 未追跡ファイルもdiffに含めるため、worktree側のindexへ全部addしてから --cached
    // (worktreeは独立indexを持つので本体には影響しない。node_modulesはジャンクションだが
    //  .gitignore で除外されている前提。add -A は .gitignore を尊重する)
    await this.git(['add', '-A'], info.dir);
    return this.git(['diff', '--cached', '--binary'], info.dir);
  }

  /** patchを本体workspaceへ適用する(3-way。競合時はエラーで何も適用されない) */
  async applyPatch(patch: string): Promise<void> {
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'amateras-patch-'));
    const file = join(dir, 'task.patch');
    try {
      await writeFile(file, patch, 'utf8');
      await this.git(['apply', '--3way', file], this.repoDir);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** worktreeとブランチを破棄(本体は無傷) */
  async remove(info: TaskWorktreeInfo): Promise<void> {
    await rm(join(info.dir, 'node_modules'), { force: true, recursive: false }).catch(() => {});
    await this.git(['worktree', 'remove', '--force', info.dir], this.repoDir).catch(() => {});
    await rm(info.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    await this.git(['branch', '-D', info.branch], this.repoDir).catch(() => {});
    await this.git(['worktree', 'prune'], this.repoDir).catch(() => {});
  }
}
