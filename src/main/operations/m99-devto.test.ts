import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../shared/types';
import type { LLMProvider } from '../providers/types';
import { createDevtoAdapter, DevtoWriter } from './adapters/devto';
import { DraftStore } from './amenoUzume';
import { OperationsManager } from './manager';

/**
 * M99-16: dev.to(英語圏pull型出口)。
 * 掟の固定: キー無し=execute空(宣言と実挙動の一致)/ 送信は岩戸の全文承認後のみ /
 * published=false は下書き送信(公開の最終ボタンはdev.to上=二重の人間確認)。
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm99-devto-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const jsonRes = (data: unknown, ok = true, status = 200): { ok: boolean; status: number; json(): Promise<unknown> } => ({
  ok,
  status,
  json: () => Promise.resolve(data),
});

describe('M99-16: DevtoWriter / アダプタ', () => {
  it('キー無しは execute 空+executorなし、キー有りは article', () => {
    const without = createDevtoAdapter(null);
    expect(without.capabilities.execute).toEqual([]);
    expect(without.executor).toBeUndefined();
    const withKey = createDevtoAdapter('key-1');
    expect(withKey.capabilities.execute).toEqual(['article']);
    expect(withKey.executor).toBeDefined();
  });

  it('publishArticle: api-keyヘッダ+article形式で送り、タグは4つまでに切る', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ url: 'https://dev.to/u/a-1' }));
    const writer = new DevtoWriter('key-1', fetchImpl as never);
    const out = await writer.publishArticle({
      title: 'T',
      bodyMarkdown: '# body',
      tags: ['a', 'b', 'c', 'd', 'e'],
      published: false,
    });
    expect(out).toContain('下書きとして送った');
    expect(out).toContain('https://dev.to/u/a-1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://dev.to/api/articles');
    expect(init.headers['api-key']).toBe('key-1');
    const body = JSON.parse(init.body) as { article: Record<string, unknown> };
    expect(body.article['published']).toBe(false);
    expect(body.article['tags']).toEqual(['a', 'b', 'c', 'd']);
  });

  it('APIエラーはHTTP状態と本文つきで投げる(黙って成功にしない)', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ error: 'Validation failed' }, false, 422));
    const writer = new DevtoWriter('key-1', fetchImpl as never);
    await expect(writer.publishArticle({ title: 'T', bodyMarkdown: 'b', published: true })).rejects.toThrow(
      /422.*Validation failed/,
    );
  });
});

describe('M99-16: draftDevtoPost(岩戸経由)', () => {
  function makeManager(opts: { approve: boolean; key: string | null; fetchImpl: ReturnType<typeof vi.fn> }): OperationsManager {
    const out = JSON.stringify({ analysis: '', paramChanges: [], proposals: [] });
    return new OperationsManager({
      userDataDir: dir,
      getConfig: () => ({ operations: { enabled: true, repos: [], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(opts.approve),
      bandProvider: () =>
        ({
          name: 'fake',
          // eslint-disable-next-line @typescript-eslint/require-await
          async *complete() {
            yield { type: 'text_delta', text: out };
            yield { type: 'message_done', usage: { inputTokens: 1, outputTokens: 1 } };
          },
        }) as unknown as LLMProvider,
      ghRunner: async () => '[]',
      fetchImpl: opts.fetchImpl as never,
      getDevtoSecret: () => opts.key,
    });
  }

  it('承認 → published:false で送信され、下書きは staged/devto になる', async () => {
    const drafts = new DraftStore(join(dir, 'operations'));
    const [d] = drafts.add([{ kind: 'article-body', title: 'EN article', body: '# hello' }]);
    const fetchImpl = vi.fn(async () => jsonRes({ url: 'https://dev.to/u/a-2' }));
    const manager = makeManager({ approve: true, key: 'key-1', fetchImpl });
    await manager.status();

    const r = await manager.draftDevtoPost(d!.id, false);
    expect(r.ok, r.detail).toBe(true);
    const call = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    const sent = JSON.parse(call[1].body) as { article: Record<string, unknown> };
    expect(sent.article['published']).toBe(false);
    const after = new DraftStore(join(dir, 'operations')).list().find((x: { id: string }) => x.id === d!.id);
    expect(after?.status).toBe('staged');
    expect(after?.media).toBe('devto');
  });

  it('岩戸で却下 → 送信されず draft のまま / キー未設定は岩戸前に拒否', async () => {
    const drafts = new DraftStore(join(dir, 'operations'));
    const [d] = drafts.add([{ kind: 'article-body', title: 'EN', body: 'b' }]);
    const fetchImpl = vi.fn(async () => jsonRes({ url: 'x' }));
    const rejected = makeManager({ approve: false, key: 'key-1', fetchImpl });
    await rejected.status();
    expect((await rejected.draftDevtoPost(d!.id, false)).ok).toBe(false);
    expect(fetchImpl.mock.calls.length).toBe(0);

    const noKey = makeManager({ approve: true, key: null, fetchImpl });
    await noKey.status();
    const r = await noKey.draftDevtoPost(d!.id, false);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('APIキーが未設定');
  });
});
