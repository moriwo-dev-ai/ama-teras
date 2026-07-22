import { afterEach, describe, expect, it, vi } from 'vitest';
import zennReachabilityCheck, {
  buildInboxReport,
  buildZennUrl,
  interpretHttpStatus,
  isValidZennSlug,
  type ZennSlugReachability,
} from './zenn_reachability_check';
import type { ToolContext } from '../types';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {}, ...overrides };
}

function fakeResponse(status: number): Response {
  return {
    status,
    body: { cancel: async () => {} },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('純ロジック', () => {
  it('interpretHttpStatus: 2xx のみ ok、それ以外は読めない', () => {
    expect(interpretHttpStatus(200).status).toBe('ok');
    expect(interpretHttpStatus(299).status).toBe('ok');
    expect(interpretHttpStatus(404).status).toBe('http_error');
    expect(interpretHttpStatus(404).detail).toContain('未反映');
    expect(interpretHttpStatus(500).status).toBe('http_error');
    expect(interpretHttpStatus(301).status).toBe('http_error');
  });

  it('buildZennUrl: username+slug から実 URL を組み立てる(kind 既定=articles)', () => {
    expect(buildZennUrl('foo', 'abc-123', 'articles')).toBe('https://zenn.dev/foo/articles/abc-123');
    expect(buildZennUrl('foo', 'book_1', 'books')).toBe('https://zenn.dev/foo/books/book_1');
  });

  it('isValidZennSlug: 妥当な slug だけを許可する', () => {
    expect(isValidZennSlug('abc-123_x')).toBe(true);
    expect(isValidZennSlug('')).toBe(false);
    expect(isValidZennSlug('Has Upper')).toBe(false);
    expect(isValidZennSlug('../etc')).toBe(false);
    expect(isValidZennSlug('-leading')).toBe(false);
  });

  it('buildInboxReport: 読めないものだけを god-failure/metrics として出す', () => {
    const results: ZennSlugReachability[] = [
      { slug: 'ok-one', url: 'https://zenn.dev/u/articles/ok-one', status: 'ok', statusCode: 200, detail: 'HTTP 200: 読める' },
      { slug: 'ng-one', url: 'https://zenn.dev/u/articles/ng-one', status: 'http_error', statusCode: 404, detail: 'HTTP 404: Zenn 上に存在しない(未反映の可能性)' },
      { slug: 'ng-two', url: 'https://zenn.dev/u/articles/ng-two', status: 'unreachable', statusCode: null, detail: '接続失敗: boom' },
    ];
    const report = buildInboxReport(results);
    expect(report).toContain('全3件中 ok=1 / 読めない=2件');
    expect(report).toContain('god-failure/metrics');
    expect(report).toContain('ng-one');
    expect(report).toContain('ng-two');
    expect(report).toContain('(404)');
    expect(report).not.toContain('ok-one の url');
    expect(report).not.toContain('- slug: ok-one');
  });

  it('buildInboxReport: 全部読めるなら受け箱は空', () => {
    const report = buildInboxReport([
      { slug: 'a', url: 'https://zenn.dev/u/articles/a', status: 'ok', statusCode: 200, detail: 'HTTP 200: 読める' },
    ]);
    expect(report).toContain('受け箱に出す項目はない');
    expect(report).not.toContain('god-failure/metrics');
  });
});

describe('execute(バリデーション)', () => {
  it('username が空ならエラー', async () => {
    const r = await zennReachabilityCheck.execute({ username: '', slugs: ['a'] }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('username');
  });

  it('slugs が空配列ならエラー', async () => {
    const r = await zennReachabilityCheck.execute({ username: 'u', slugs: [] }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('slugs');
  });

  it('不正な slug を含むとエラー(fetch しない)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await zennReachabilityCheck.execute({ username: 'u', slugs: ['ok', '../bad'] }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('不正な slug');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('kind が不正ならエラー', async () => {
    const r = await zennReachabilityCheck.execute({ username: 'u', slugs: ['a'], kind: 'pages' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('kind');
  });
});

describe('execute(到達性チェック)', () => {
  it('読める slug は ok、404 は受け箱行きになる', async () => {
    const fetchMock = vi.fn(async (url: string) => (url.includes('ng') ? fakeResponse(404) : fakeResponse(200)));
    vi.stubGlobal('fetch', fetchMock);
    const r = await zennReachabilityCheck.execute({ username: 'u', slugs: ['ok-one', 'ng-one'] }, ctx());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('全2件中 ok=1 / 読めない=1件');
    expect(r.content).toContain('god-failure/metrics');
    expect(r.content).toContain('ng-one');
    expect(r.content).toContain('(404)');
  });

  it('全部読めるときは isError なし・受け箱は空', async () => {
    const fetchMock = vi.fn(async (_url: string) => fakeResponse(200));
    vi.stubGlobal('fetch', fetchMock);
    const r = await zennReachabilityCheck.execute({ username: 'u', slugs: ['a', 'b'] }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('受け箱に出す項目はない');
    // kind 省略時は articles URL
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/articles/');
  });

  it('kind=books は books の URL で確認する', async () => {
    const fetchMock = vi.fn(async (_url: string) => fakeResponse(200));
    vi.stubGlobal('fetch', fetchMock);
    await zennReachabilityCheck.execute({ username: 'u', slugs: ['my-book'], kind: 'books' }, ctx());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://zenn.dev/u/books/my-book');
  });

  it('接続失敗は unreachable として受け箱に出る', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await zennReachabilityCheck.execute({ username: 'u', slugs: ['dead'] }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('unreachable');
    expect(r.content).toContain('ECONNREFUSED');
  });
});
