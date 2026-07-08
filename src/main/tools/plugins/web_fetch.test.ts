import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types';
import plugin, { isTextualContentType } from './web_fetch';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {}, ...overrides };
}

function htmlResponse(html: string, init: { status?: number; contentType?: string } = {}): Response {
  return new Response(html, {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'text/html; charset=utf-8' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web_fetch plugin', () => {
  it('name がファイル名と一致し risk が safe', () => {
    expect(plugin.name).toBe('web_fetch');
    expect(plugin.risk).toBe('safe');
    expect(plugin.warnings?.some((w) => w.includes('ネットワーク'))).toBe(true);
  });

  it('HTMLページを取得して title/text/links/truncated を返す', async () => {
    const html = [
      '<!doctype html><html><head><title>Sample &amp; Page</title>',
      '<style>body{color:red}</style><script>var x=1;</script></head>',
      '<body><h1>Hello</h1><p>World &copy; text</p>',
      '<a href="/docs/intro">intro</a>',
      '<a href="https://other.example.org/page#frag">other</a>',
      '<a href="javascript:void(0)">js</a>',
      '<a href="#top">top</a>',
      '</body></html>',
    ].join('\n');
    const fetchMock = vi.fn(async () => htmlResponse(html));
    vi.stubGlobal('fetch', fetchMock);

    const r = await plugin.execute({ url: 'https://example.com/base/page' }, ctx());
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content) as {
      status: number;
      url: string;
      title: string | null;
      text: string;
      links: string[];
      truncated: boolean;
    };

    expect(parsed.status).toBe(200);
    expect(parsed.url).toBe('https://example.com/base/page');
    expect(parsed.title).toBe('Sample & Page');
    expect(parsed.text).toContain('Hello');
    expect(parsed.text).toContain('World © text');
    // script/style は本文から除去される
    expect(parsed.text).not.toContain('var x=1');
    expect(parsed.text).not.toContain('color:red');
    // 相対リンクは絶対URLへ解決され、javascript:/#fragment は除外
    expect(parsed.links).toContain('https://example.com/docs/intro');
    expect(parsed.links).toContain('https://other.example.org/page');
    expect(parsed.links.some((l) => l.startsWith('javascript:'))).toBe(false);
    expect(parsed.truncated).toBe(false);

    // GET 1回のみ・GET以外を使わない
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown[] | undefined;
    expect(call).toBeDefined();
    const initArg = call?.[1] as { method?: string; redirect?: string } | undefined;
    expect(initArg?.method).toBe('GET');
    expect(initArg?.redirect).toBe('follow');
  });

  it('長い本文は max_chars で切り詰めて truncated:true', async () => {
    const long = 'あ'.repeat(5000);
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(`<html><body><p>${long}</p></body></html>`)));

    const r = await plugin.execute({ url: 'https://example.com/', max_chars: 100 }, ctx());
    const parsed = JSON.parse(r.content) as { text: string; truncated: boolean };
    expect(parsed.text.length).toBe(100);
    expect(parsed.truncated).toBe(true);
  });

  it('バイナリは本文をダウンロードせず contentType とサイズだけ返す', async () => {
    const res = new Response(new Uint8Array([0x50, 0x4b]), {
      status: 200,
      headers: { 'content-type': 'application/zip', 'content-length': '13002344' },
    });
    const fetchMock = vi.fn(async () => res);
    vi.stubGlobal('fetch', fetchMock);

    const r = await plugin.execute({ url: 'https://example.com/file.zip' }, ctx());
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content) as {
      status: number;
      contentType: string;
      bytes: number | null;
      text: string | null;
      note?: string;
    };
    expect(parsed.status).toBe(200);
    expect(parsed.contentType).toBe('application/zip');
    expect(parsed.bytes).toBe(13002344);
    expect(parsed.text).toBeNull();
    expect(parsed.note).toContain('binary');
  });

  it('text/plain はタグ処理せずそのまま返す(links は空)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse('plain body text', { contentType: 'text/plain' })),
    );
    const r = await plugin.execute({ url: 'https://example.com/robots.txt' }, ctx());
    const parsed = JSON.parse(r.content) as { text: string; title: string | null; links: string[] };
    expect(parsed.text).toBe('plain body text');
    expect(parsed.title).toBeNull();
    expect(parsed.links).toEqual([]);
  });

  it('http/https 以外のスキームは fetch せず拒否', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await plugin.execute({ url: 'file:///etc/passwd' }, ctx());
    expect(r.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('不正な入力はエラー', async () => {
    const r1 = await plugin.execute(null, ctx());
    expect(r1.isError).toBe(true);
    const r2 = await plugin.execute({ url: '' }, ctx());
    expect(r2.isError).toBe(true);
    const r3 = await plugin.execute({ url: 'not a url at all %%%' }, ctx());
    expect(r3.isError).toBe(true);
  });

  it('ネットワークエラーは isError で返す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }),
    );
    const r = await plugin.execute({ url: 'https://no-such-host.invalid/' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('取得失敗');
  });

  it('HTTPエラーステータスでも本文とステータスを返す(isErrorにしない)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse('<html><title>404 Not Found</title><body>gone</body></html>', { status: 404 })),
    );
    const r = await plugin.execute({ url: 'https://example.com/missing' }, ctx());
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content) as { status: number; title: string | null };
    expect(parsed.status).toBe(404);
    expect(parsed.title).toBe('404 Not Found');
  });
});

describe('isTextualContentType', () => {
  it('テキスト系を判別する', () => {
    expect(isTextualContentType('text/html; charset=utf-8')).toBe(true);
    expect(isTextualContentType('application/json')).toBe(true);
    expect(isTextualContentType('application/xhtml+xml')).toBe(true);
    expect(isTextualContentType(null)).toBe(true);
    expect(isTextualContentType('application/zip')).toBe(false);
    expect(isTextualContentType('image/png')).toBe(false);
    expect(isTextualContentType('application/octet-stream')).toBe(false);
  });
});
