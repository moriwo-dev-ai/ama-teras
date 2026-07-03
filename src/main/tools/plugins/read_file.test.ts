import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import readFile from './read_file';
import type { ToolContext } from '../types';

let dir: string;
function ctx(): ToolContext {
  return { cwd: dir, signal: new AbortController().signal, log: () => {} };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycodex-readfile-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('read_file サイズ上限(指摘#8)', () => {
  it('上限超のファイルは読み込まずエラーを返す(OOM防止)', async () => {
    const big = join(dir, 'big.log');
    await writeFile(big, '');
    await truncate(big, 11 * 1024 * 1024); // 11MB のスパースファイル(即時作成)
    const r = await readFile.execute({ path: big }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('大きすぎる');
  });

  it('通常サイズのファイルは読める', async () => {
    const small = join(dir, 'small.txt');
    await writeFile(small, 'line1\nline2\n');
    const r = await readFile.execute({ path: small }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('line1');
  });
});
