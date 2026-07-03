import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import grep, { looksCatastrophic } from './grep';
import type { ToolContext } from '../types';

let dir: string;
function ctx(): ToolContext {
  return { cwd: dir, signal: new AbortController().signal, log: () => {} };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycodex-grep-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('looksCatastrophic(ReDoS検出・指摘#9)', () => {
  it('ネスト量指定子の危険パターンを検出する', () => {
    for (const p of ['(a+)+$', '(a*)*', '(a+)*', '(.*)*', '([a-z]+)+', '(\\w+){2,}']) {
      expect(looksCatastrophic(p), p).toBe(true);
    }
  });

  it('通常パターンは誤検出しない', () => {
    for (const p of ['foo.*bar', 'function\\s+\\w+', '(foo|bar)', '(abc)+', '\\d+\\.\\d+', 'a+b+']) {
      expect(looksCatastrophic(p), p).toBe(false);
    }
  });
});

describe('grep.execute のReDoS防御', () => {
  it('危険な正規表現はハングせず即エラーを返す', async () => {
    // 修正前はこの入力(長い非マッチ行)で re.test が指数時間ハングしていた
    await writeFile(join(dir, 'evil.txt'), `${'a'.repeat(50)}!\n`);
    const start = Date.now();
    const r = await grep.execute({ pattern: '(a+)+$', path: dir }, ctx());
    expect(Date.now() - start).toBeLessThan(1000); // 固まらない
    expect(r.isError).toBe(true);
    expect(r.content).toContain('ReDoS');
  });

  it('通常の検索は従来どおり動く', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world\nfoo bar\n');
    const r = await grep.execute({ pattern: 'foo', path: dir }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('foo bar');
  });
});
