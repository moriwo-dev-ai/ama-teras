import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createZennRepoAdapter } from './adapters/zennRepo';

/**
 * M81: 再デプロイを押しても、Zennは403のまま。**空コミットでは記事は再デプロイされない**
 * (変更されたファイルが1つも無いので、Zennから見て同期すべき記事が存在しない)。
 * Zennに「この記事は変わった」と伝えるには、その記事のファイル自体に差分が要る。
 * 本文は1文字も変えたくないので、末尾の改行だけを足し引きする。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm81-'));
  mkdirSync(join(dir, 'articles'), { recursive: true });
  writeFileSync(join(dir, 'articles', 'ghost-article-001.md'), '---\ntitle: "x"\npublished: true\n---\n\n本文\n', 'utf8');
  mkdirSync(join(dir, '.git'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('M81: 再デプロイは記事ファイルに差分を付ける', () => {
  it('空コミットではなく、記事を add してコミットする(Zennが同期対象として見る)', async () => {
    const cmds: string[][] = [];
    const adapter = createZennRepoAdapter(() => dir, {
      run: async (args) => {
        cmds.push(args);
        return '';
      },
    });

    const detail = await adapter.executor!('redeploy-article', { slug: 'ghost-article-001' });

    expect(cmds.some((c) => c.includes('--allow-empty'))).toBe(false); // これが効かなかった
    expect(cmds[0]).toEqual(['add', 'articles/ghost-article-001.md']);
    expect(cmds[1]?.[0]).toBe('commit');
    expect(cmds[2]).toEqual(['push']);
    expect(detail).toContain('本文は変えていない');
  });

  it('差分は末尾改行1文字だけ。本文は1文字も変わらない', async () => {
    const adapter = createZennRepoAdapter(() => dir, { run: async () => '' });
    const before = readFileSync(join(dir, 'articles', 'ghost-article-001.md'), 'utf8');

    await adapter.executor!('redeploy-article', { slug: 'ghost-article-001' });

    const after = readFileSync(join(dir, 'articles', 'ghost-article-001.md'), 'utf8');
    expect(after).not.toBe(before); // 差分が無いとZennは動かない
    expect(after.replace(/\n+$/, '')).toBe(before.replace(/\n+$/, '')); // 中身は同じ
  });

  it('存在しない記事は触らない', async () => {
    const git = vi.fn(async () => '');
    const adapter = createZennRepoAdapter(() => dir, { run: git });
    await expect(adapter.executor!('redeploy-article', { slug: 'not-exist-000000' })).rejects.toThrow(/見つからない/);
    expect(git).not.toHaveBeenCalled();
  });
});
