import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginBootWithSentinel,
  clearSentinel,
  markBootHealthy,
  readSentinel,
  SENTINEL_FILENAME,
  writeSentinel,
} from './sentinel';
import { rebuildAndHealthBoot } from './supervisor';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amateras-sentinel-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('再起動センチネル(M20: クラッシュ検知プロトコル)', () => {
  it('センチネル無しの通常起動は何も起きない', () => {
    expect(beginBootWithSentinel(dir)).toEqual({ sentinel: null, safeMode: false });
    expect(markBootHealthy(dir)).toBeNull();
  });

  it('正常な進化再起動: 書く→起動(attempts=1)→完走で削除+タグが返る', () => {
    writeSentinel(dir, 'evolve/9', 'abc123');
    const boot = beginBootWithSentinel(dir);
    expect(boot.safeMode).toBe(false);
    expect(boot.sentinel?.bootAttempts).toBe(1);

    const done = markBootHealthy(dir);
    expect(done?.tag).toBe('evolve/9');
    expect(done?.prevCommit).toBe('abc123');
    expect(existsSync(join(dir, SENTINEL_FILENAME))).toBe(false);
  });

  it('1回クラッシュ後の起動はまだセーフモードでない(2回連続が条件)', () => {
    writeSentinel(dir, 'evolve/9', 'abc123');
    beginBootWithSentinel(dir); // 起動1(この後クラッシュ=完走マークなし)
    const boot2 = beginBootWithSentinel(dir); // 起動2
    expect(boot2.safeMode).toBe(false);
    expect(boot2.sentinel?.bootAttempts).toBe(2);
    // 起動2が完走すれば回復
    expect(markBootHealthy(dir)?.tag).toBe('evolve/9');
  });

  it('2回連続クラッシュ → 3回目の起動でセーフモード(センチネルは残す)', () => {
    writeSentinel(dir, 'evolve/9', 'abc123');
    beginBootWithSentinel(dir); // 起動1 → クラッシュ
    beginBootWithSentinel(dir); // 起動2 → クラッシュ(attempts=2が残る)
    const boot3 = beginBootWithSentinel(dir);
    expect(boot3.safeMode).toBe(true);
    expect(boot3.sentinel?.tag).toBe('evolve/9');
    expect(boot3.sentinel?.prevCommit).toBe('abc123');
    // セーフモードでは削除も加算もしない(4回目もセーフモードのまま)
    expect(beginBootWithSentinel(dir).safeMode).toBe(true);
    expect(readSentinel(dir)?.bootAttempts).toBe(2);
  });

  it('clearSentinel(ユーザー解除)でセーフモードから抜けられる', () => {
    writeSentinel(dir, 'evolve/9', 'abc123');
    beginBootWithSentinel(dir);
    beginBootWithSentinel(dir);
    expect(beginBootWithSentinel(dir).safeMode).toBe(true);
    expect(clearSentinel(dir)).toBe(true);
    expect(beginBootWithSentinel(dir)).toEqual({ sentinel: null, safeMode: false });
    expect(clearSentinel(dir)).toBe(false); // 対象なし
  });

  it('壊れたセンチネルJSONは無視(通常起動)', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, SENTINEL_FILENAME), '{broken', 'utf8');
    expect(beginBootWithSentinel(dir)).toEqual({ sentinel: null, safeMode: false });
  });
});

describe('rebuildAndHealthBoot(M20: 昇格後の再ビルド+フルアプリ健全性)', () => {
  it('build失敗 → ok:false(smoke-bootは実行しない)', async () => {
    const run = vi.fn(async (cmd: string) =>
      cmd === 'npm run build' ? { code: 1, output: 'build error' } : { code: 0, output: '' },
    );
    const r = await rebuildAndHealthBoot('/repo', run);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('再ビルド失敗');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('smoke-boot失敗 → ok:false', async () => {
    const run = vi.fn(async (cmd: string) =>
      cmd.includes('--smoke-boot') ? { code: 1, output: 'mount fail' } : { code: 0, output: '' },
    );
    const r = await rebuildAndHealthBoot('/repo', run);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('健全性チェック失敗');
  });

  it('両方成功 → ok:true。smoke-boot は MYCODEX_SMOKE=1 で起動される', async () => {
    const calls: [string, string | undefined][] = [];
    const run = vi.fn(async (cmd: string, _cwd: string, env?: Record<string, string>) => {
      calls.push([cmd, env?.['MYCODEX_SMOKE']]);
      return { code: 0, output: '' };
    });
    const r = await rebuildAndHealthBoot('/repo', run);
    expect(r.ok).toBe(true);
    expect(calls[0]![0]).toBe('npm run build');
    expect(calls[1]![0]).toBe('npx electron . --smoke-boot');
    expect(calls[1]![1]).toBe('1');
  });
});
