import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGit } from './git';
import { nextJobId } from './promote';
import { WorktreeManager } from './worktree';

/**
 * M50: **強制終了で残ったB環境が、次のジョブを即死させる**(実害: ジョブ14・15)。
 *
 * remove() はジョブの後始末でしか呼ばれない = taskkill・クラッシュでは走らない。
 * 残った `evolve/job-N` ブランチに、タグ基準で再採番された同じIDがぶつかり、
 * `worktree add` が `fatal: a branch named 'evolve/job-N' already exists` で落ちる。
 * ジョブは中身(生成・検証)を一度も見られないまま failed になる。
 */
let base: string;
let repo: string;
let worktreeBase: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'amateras-sweep-'));
  repo = join(base, 'repo');
  worktreeBase = join(base, 'evolve');
  await mkdir(repo, { recursive: true });
  await runGit(['init', '-b', 'main'], repo);
  await runGit(['config', 'user.name', 'test'], repo);
  await runGit(['config', 'user.email', 'test@example.com'], repo);
  await writeFile(join(repo, 'package.json'), '{"name":"fixture"}\n');
  await runGit(['add', '-A'], repo);
  await runGit(['commit', '-m', 'init'], repo);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true }).catch(() => {});
});

describe('M50: 進化ジョブの残骸掃除と採番', () => {
  it('強制終了で残ったworktreeとディレクトリを掃除し、空のブランチも消す', async () => {
    const wt = new WorktreeManager(repo, worktreeBase);
    const info = await wt.create(7, 'main'); // 作りっぱなし = 強制終了された状態
    expect(existsSync(info.dir)).toBe(true);

    const swept = await wt.sweepStale();

    expect(existsSync(info.dir)).toBe(false);
    expect(swept).toContain('evolve/job-7'); // 生成物ゼロ = ただのゴミ
    expect(await runGit(['branch', '--list', 'evolve/job-*'], repo)).toBe('');
    // 掃除した後なら、同じIDでもう一度作れる(=これが直ったこと)
    await expect(wt.create(7, 'main')).resolves.toBeDefined();
  });

  it('生成物が入っているブランチは消さない(worktreeだけ畳む)', async () => {
    const wt = new WorktreeManager(repo, worktreeBase);
    const info = await wt.create(8, 'main');
    await writeFile(join(info.dir, 'generated.ts'), 'export const x = 1;\n');
    await runGit(['add', '-A'], info.dir);
    await runGit(['commit', '-m', 'evolve: 生成物'], info.dir);

    await wt.sweepStale();

    expect(existsSync(info.dir)).toBe(false); // B環境(ディスク)は畳む
    expect(await runGit(['branch', '--list', 'evolve/job-8'], repo)).toContain('evolve/job-8');
    // 生成物は git に残っている = ユーザーが後から拾い直せる
    expect(await runGit(['show', '--stat', 'evolve/job-8'], repo)).toContain('generated.ts');
  });

  it('A(稼働中のcheckout)には触らない', async () => {
    const wt = new WorktreeManager(repo, worktreeBase);
    await wt.sweepStale();
    expect(existsSync(join(repo, 'package.json'))).toBe(true);
    expect(await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).toBe('main');
  });

  it('掃除に失敗しても、残骸ブランチのIDは再利用しない(採番はタグとブランチの両方を見る)', async () => {
    await runGit(['branch', 'evolve/job-9'], repo); // 昇格しなかったジョブの残骸(タグは無い)

    expect(await nextJobId(repo)).toBe(10);
  });

  it('昇格タグと残骸ブランチが混在しても、最大値の次を返す', async () => {
    await runGit(['tag', 'evolve/3'], repo);
    await runGit(['branch', 'evolve/job-15'], repo);

    expect(await nextJobId(repo)).toBe(16);
  });
});
