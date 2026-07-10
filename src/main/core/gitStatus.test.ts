import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workspaceGitStatus } from './gitStatus';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amateras-gitstat-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

// Windows では git のプロセス起動が遅く、並列負荷で既定5sを超えることがある
describe('workspaceGitStatus(M15-4)', { timeout: 20_000 }, () => {
  it('git無しディレクトリは isGit:false', async () => {
    expect(await workspaceGitStatus(dir)).toEqual({ isGit: false });
  });

  it('gitリポジトリではブランチと未コミット数を返す', async () => {
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: dir, windowsHide: true });
    };
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 't']);
    git(['config', 'user.email', 't@e.c']);
    await writeFile(join(dir, 'a.txt'), '1', 'utf8');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init']);

    expect(await workspaceGitStatus(dir)).toEqual({ isGit: true, branch: 'main', dirtyCount: 0 });

    await writeFile(join(dir, 'a.txt'), '2', 'utf8');
    await writeFile(join(dir, 'b.txt'), 'new', 'utf8');
    const dirty = await workspaceGitStatus(dir);
    expect(dirty.isGit).toBe(true);
    expect(dirty.dirtyCount).toBe(2);
  });
});
