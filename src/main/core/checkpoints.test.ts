import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointManager } from './checkpoints';

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycodex-ckpt-repo-'));
  await git(['init', '-q'], dir);
  await git(['config', 'user.name', 'test'], dir);
  await git(['config', 'user.email', 'test@example.com'], dir);
  await writeFile(join(dir, 'a.txt'), 'v1');
  await git(['add', '-A'], dir);
  await git(['commit', '-q', '-m', 'init'], dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('CheckpointManager(M11-3・実git)', () => {
  it('スナップショット→破壊→復元で作業ツリーが戻る。HEAD・index・他refsは不変', async () => {
    const cm = new CheckpointManager(dir);
    const headBefore = await git(['rev-parse', 'HEAD'], dir);

    await writeFile(join(dir, 'a.txt'), 'v2');
    const sha1 = await cm.snapshot('s1', 'edit後');
    expect(sha1).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(join(dir, 'a.txt'), 'v3-broken');
    const r = await cm.restore(sha1!);
    expect(r.ok).toBe(true);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('v2');

    // HEAD は動いていない
    expect(await git(['rev-parse', 'HEAD'], dir)).toBe(headBefore);
    // index(ステージ)は汚れていない
    expect(await git(['diff', '--cached', '--name-only'], dir)).toBe('');
    // refs/mycodex/ 以外の ref は増えていない(ブランチ・タグを作らない)
    const refs = (await git(['for-each-ref', '--format=%(refname)'], dir)).split('\n');
    for (const ref of refs.filter((x) => !x.startsWith('refs/mycodex/'))) {
      expect(ref.startsWith('refs/heads/')).toBe(true);
    }
  });

  it('変更なしは skip(null)。変更があれば同一セッションのチェーンに積まれる', async () => {
    const cm = new CheckpointManager(dir);
    await writeFile(join(dir, 'a.txt'), 'v2');
    const sha1 = await cm.snapshot('s1', 'one');
    expect(sha1).not.toBeNull();

    expect(await cm.snapshot('s1', 'no-change')).toBeNull();

    await writeFile(join(dir, 'b.txt'), 'untracked-new');
    const sha2 = await cm.snapshot('s1', 'two');
    expect(sha2).not.toBeNull();
    expect(sha2).not.toBe(sha1);
    // 親チェーン: sha2 の親は sha1、sha1 の親は HEAD
    expect(await git(['rev-parse', `${sha2}^`], dir)).toBe(sha1);
    expect(await git(['rev-parse', `${sha1}^`], dir)).toBe(await git(['rev-parse', 'HEAD'], dir));

    const list = await cm.list();
    expect(list.map((c) => c.sha)).toEqual([sha2, sha1]);
    expect(list[0]!.sessionId).toBe('s1');
    expect(list[0]!.label).toBe('two');
    expect(list[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('untracked ファイルも保存される。復元は上書き(後から増えたファイルは消さない)', async () => {
    const cm = new CheckpointManager(dir);
    await writeFile(join(dir, 'a.txt'), 'v2');
    const sha1 = await cm.snapshot('s1', 'one');

    await writeFile(join(dir, 'a.txt'), 'v3');
    await writeFile(join(dir, 'later.txt'), 'created-after');
    const r = await cm.restore(sha1!);
    expect(r.ok).toBe(true);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('v2');
    // 既知の制約: チェックポイント後に増えたファイルは削除されない
    expect(await readFile(join(dir, 'later.txt'), 'utf8')).toBe('created-after');
  });

  it('復元前に現状態が pre-restore へ自動退避され、往復できる', async () => {
    const cm = new CheckpointManager(dir);
    await writeFile(join(dir, 'a.txt'), 'v2');
    const sha1 = await cm.snapshot('s1', 'one');

    await writeFile(join(dir, 'a.txt'), 'v3');
    await cm.restore(sha1!);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('v2');

    const backup = (await cm.list()).find((c) => c.sessionId === 'pre-restore');
    expect(backup).toBeDefined();
    const r2 = await cm.restore(backup!.sha);
    expect(r2.ok).toBe(true);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('v3');
  });

  it('非gitディレクトリでは完全noop(snapshot=null / list=[] / restore=失敗メッセージ)', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'mycodex-ckpt-plain-'));
    try {
      const logs: string[] = [];
      const cm = new CheckpointManager(plain, (l) => logs.push(l));
      expect(await cm.snapshot('s1', 'x')).toBeNull();
      expect(await cm.list()).toEqual([]);
      const r = await cm.restore('a'.repeat(40));
      expect(r.ok).toBe(false);
      expect(logs.some((l) => l.includes('git リポジトリではない'))).toBe(true);
    } finally {
      await rm(plain, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('コミットの無い初期化直後のリポジトリでも動く(親なしコミット)', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'mycodex-ckpt-fresh-'));
    try {
      await git(['init', '-q'], fresh);
      await git(['config', 'user.name', 'test'], fresh);
      await git(['config', 'user.email', 'test@example.com'], fresh);
      await writeFile(join(fresh, 'c.txt'), 'first');
      const cm = new CheckpointManager(fresh);
      const sha = await cm.snapshot('s1', 'first');
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect((await cm.list())[0]!.label).toBe('first');
    } finally {
      await rm(fresh, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('不正な sha は復元を拒否する', async () => {
    const cm = new CheckpointManager(dir);
    expect((await cm.restore('HEAD')).ok).toBe(false);
    expect((await cm.restore('main; rm -rf /')).ok).toBe(false);
  });
});
