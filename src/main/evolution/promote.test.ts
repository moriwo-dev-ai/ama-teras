import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGit } from './git';
import { assertPromotable, promoteBranch } from './promote';

let base: string;
let repo: string;

async function commitAll(msg: string): Promise<void> {
  await runGit(['add', '-A'], repo);
  await runGit(['commit', '-m', msg], repo);
}

/** main 上に plugins/foo.ts を持つブランチ branch を作って main へ戻る */
async function makePluginBranch(branch: string, content: string): Promise<void> {
  await runGit(['checkout', '-b', branch], repo);
  await writeFile(join(repo, 'src/main/tools/plugins/foo.ts'), content);
  await commitAll('add foo plugin');
  await runGit(['checkout', 'main'], repo);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'mycodex-promote-'));
  repo = join(base, 'repo');
  await mkdir(join(repo, 'src/main/tools/plugins'), { recursive: true });
  await runGit(['init', '-b', 'main'], repo);
  await runGit(['config', 'user.name', 'test'], repo);
  await runGit(['config', 'user.email', 'test@example.com'], repo);
  await writeFile(join(repo, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(join(repo, 'PROGRESS.md'), '# init\n');
  await writeFile(join(repo, 'src/main/tools/plugins/.gitkeep'), '');
  await commitAll('init');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true }).catch(() => {});
});

// Windows では git のプロセス起動が遅く、並列負荷で既定5sを超えることがある
describe('assertPromotable', { timeout: 30_000 }, () => {
  it('baseRef 上なら通る', async () => {
    await expect(assertPromotable(repo, 'main')).resolves.toBeUndefined();
  });

  it('別ブランチ上なら明確なエラーで弾く', async () => {
    await runGit(['checkout', '-b', 'feature'], repo);
    await expect(assertPromotable(repo, 'main')).rejects.toThrow(/main ではない/);
  });
});

describe('promoteBranch(指摘#6)', { timeout: 30_000 }, () => {
  // 回帰: 無関係な未コミット変更(PROGRESS.md)があっても、マージが触れなければ昇格成功する
  it('無関係なdirtyツリーがあっても plugins のみのマージは成功する', async () => {
    await makePluginBranch('evolve/job-1', 'export const x = 1;\n');
    // A(main)側で無関係なトラッキング済みファイルを変更(コミットしない=dirty)
    await writeFile(join(repo, 'PROGRESS.md'), '# 作業中の変更\n');

    const { tag, mergeCommit } = await promoteBranch(repo, 'evolve/job-1', 1, 'main');
    expect(tag).toBe('evolve/1');
    expect(mergeCommit).toHaveLength(40);
    expect(existsSync(join(repo, 'src/main/tools/plugins/foo.ts'))).toBe(true);
    // タグが打たれている
    const tags = await runGit(['tag', '-l'], repo);
    expect(tags.split('\n')).toContain('evolve/1');
    // dirty だった PROGRESS.md の変更は保持される
    const status = await runGit(['status', '--porcelain'], repo);
    expect(status).toContain('PROGRESS.md');
  });

  it('マージ衝突時は merge --abort で巻き戻し MERGE_HEAD を残さない', async () => {
    // ブランチと main が同じファイルを別内容に変更 → --no-ff で衝突
    await makePluginBranch('evolve/job-2', 'export const v = "B";\n');
    await writeFile(join(repo, 'src/main/tools/plugins/foo.ts'), 'export const v = "A";\n');
    await commitAll('main側でfooを変更');

    await expect(promoteBranch(repo, 'evolve/job-2', 2, 'main')).rejects.toThrow(/ロールバック済み/);
    // MERGE_HEAD が残っていない(半マージ状態でない)
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    // タグも打たれていない
    const tags = await runGit(['tag', '-l'], repo);
    expect(tags).not.toContain('evolve/2');
  });

  it('別ブランチ上なら承認後マージに入る前に弾かれる', async () => {
    await makePluginBranch('evolve/job-3', 'export const y = 2;\n');
    await runGit(['checkout', '-b', 'feature'], repo);
    await expect(promoteBranch(repo, 'evolve/job-3', 3, 'main')).rejects.toThrow(/main ではない/);
  });
});
