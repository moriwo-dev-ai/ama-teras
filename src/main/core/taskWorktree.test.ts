import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskWorktreeManager } from './taskWorktree';

/**
 * M108: タスクworktree — 実gitで検証(モックにしない。「隔離できているつもり」が最悪の失敗)。
 */

let root: string;
let repo: string;

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-wt-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'test'], repo);
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('M108: TaskWorktreeManager(実git)', () => {
  it('create→変更→diff→remove の基本フロー。本体は終始無傷', async () => {
    const m = new TaskWorktreeManager(repo, join(root, 'tasks'));
    const wt = await m.create(1);
    expect(wt.branch).toBe('task/1');
    expect(existsSync(wt.dir)).toBe(true);

    // worktree内で編集+新規ファイル(未追跡もdiffに載ることを確認)
    writeFileSync(join(wt.dir, 'a.txt'), 'hello\nchanged\n');
    writeFileSync(join(wt.dir, 'new.txt'), 'brand new\n');
    const patch = await m.diff(wt);
    expect(patch).toContain('+changed');
    expect(patch).toContain('new.txt');

    // 本体は無傷
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('hello\n');
    expect(existsSync(join(repo, 'new.txt'))).toBe(false);

    await m.remove(wt);
    expect(existsSync(wt.dir)).toBe(false);
    expect(git(['branch', '--list', 'task/1'], repo).trim()).toBe('');
  });

  it('applyPatch で承認後の取り込みができる(worktree破棄後でもpatchは独立に適用可能)', async () => {
    const m = new TaskWorktreeManager(repo, join(root, 'tasks'));
    const wt = await m.create(2);
    writeFileSync(join(wt.dir, 'a.txt'), 'hello\nfrom-task\n');
    const patch = await m.diff(wt);
    await m.remove(wt);

    await m.applyPatch(patch);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toContain('from-task');
  });

  it('変更ゼロなら diff は空文字', async () => {
    const m = new TaskWorktreeManager(repo, join(root, 'tasks'));
    const wt = await m.create(3);
    expect((await m.diff(wt)).trim()).toBe('');
    await m.remove(wt);
  });

  it('非gitワークスペースでは明示エラー', async () => {
    const notRepo = join(root, 'plain');
    mkdirSync(notRepo);
    const m = new TaskWorktreeManager(notRepo, join(root, 'tasks2'));
    await expect(m.create(1)).rejects.toThrow(/gitリポジトリではない/);
  });

  it('同じIDの残骸があっても create は成功する(衝突の自動掃除)', async () => {
    const m = new TaskWorktreeManager(repo, join(root, 'tasks'));
    const first = await m.create(5);
    writeFileSync(join(first.dir, 'junk.txt'), 'x');
    // remove せずに(=クラッシュ相当)もう一度同じIDで作る
    const second = await m.create(5);
    expect(existsSync(second.dir)).toBe(true);
    expect(existsSync(join(second.dir, 'junk.txt'))).toBe(false); // 綺麗な作り直し
    await m.remove(second);
  });
});
