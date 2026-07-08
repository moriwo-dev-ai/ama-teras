import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types';
import plugin, { parseSearchResults, resolveResultUrl } from './web_search';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {}, ...overrides };
}

const SAMPLE_DDG_HTML = `
<html><body>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Freference%2Freact%2FuseActionState&amp;rut=abc">useActionState &ndash; React</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Freference%2Freact%2FuseActionState&amp;rut=abc">useActionState is a <b>Hook</b> that allows you to update state based on the result of a form action.</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="https://ja.react.dev/reference/react/useActionState">useActionState - React 日本語</a>
  </h2>
  <a class="result__snippet" href="https://ja.react.dev/reference/react/useActionState">フォームアクションの結果に基づいて state を更新する。</a>
</div>
<div class="result">
  <a class="result__a" href="https://ja.react.dev/reference/react/useActionState">duplicate entry</a>
</div>
</body></html>
`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web_search plugin', () => {
  it('name がファイル名と一致し risk が safe', () => {
    expect(plugin.name).toBe('web_search');
    expect(plugin.risk).toBe('safe');
    expect(plugin.warnings?.some((w) => w.includes('ネットワーク'))).toBe(true);
  });

  it('検索結果を title/url/snippet の配列で返す(リクエストはGET 1回)', async () => {
    const fetchMock = vi.fn(async () => new Response(SAMPLE_DDG_HTML, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await plugin.execute(
      { query: 'React 19 useActionState official docs', max_results: 5 },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content) as {
      query: string;
      source: string;
      results: { title: string; url: string; snippet: string }[];
    };

    expect(parsed.query).toBe('React 19 useActionState official docs');
    expect(parsed.source).toContain('duckduckgo.com');
    // 重複URLは除外され2件
    expect(parsed.results).toHaveLength(2);

    const first = parsed.results[0];
    expect(first).toBeDefined();
    expect(first?.title).toBe('useActionState – React');
    // リダイレクトURL(uddg)から実URLが復元される
    expect(first?.url).toBe('https://react.dev/reference/react/useActionState');
    expect(first?.snippet).toContain('useActionState is a Hook');

    const second = parsed.results[1];
    expect(second?.url).toBe('https://ja.react.dev/reference/react/useActionState');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown[] | undefined;
    const urlArg = call?.[0];
    expect(String(urlArg)).toContain('q=React+19+useActionState+official+docs');
    const initArg = call?.[1] as { method?: string } | undefined;
    expect(initArg?.method).toBe('GET');
  });

  it('max_results で件数を制限する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(SAMPLE_DDG_HTML, { status: 200 })));
    const r = await plugin.execute({ query: 'react', max_results: 1 }, ctx());
    const parsed = JSON.parse(r.content) as { results: unknown[] };
    expect(parsed.results).toHaveLength(1);
  });

  it('結果0件でも isError にせず note を付ける', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>no results</body></html>', { status: 200 })));
    const r = await plugin.execute({ query: 'zzz' }, ctx());
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content) as { results: unknown[]; note?: string };
    expect(parsed.results).toHaveLength(0);
    expect(parsed.note).toBeDefined();
  });

  it('検索エンドポイントのHTTPエラーは isError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('blocked', { status: 403 })));
    const r = await plugin.execute({ query: 'x' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('403');
  });

  it('ネットワーク例外は isError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const r = await plugin.execute({ query: 'x' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('network down');
  });

  it('不正な入力はエラー(fetchしない)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await plugin.execute(null, ctx())).isError).toBe(true);
    expect((await plugin.execute({}, ctx())).isError).toBe(true);
    expect((await plugin.execute({ query: '   ' }, ctx())).isError).toBe(true);
    expect((await plugin.execute({ query: 'ok', max_results: 'five' }, ctx())).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('resolveResultUrl', () => {
  it('uddg リダイレクトURLから実URLを復元する', () => {
    const url = resolveResultUrl(
      '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1&rut=xyz',
    );
    expect(url).toBe('https://example.com/page?a=1');
  });

  it('通常の http(s) URL はそのまま返す', () => {
    expect(resolveResultUrl('https://example.com/x')).toBe('https://example.com/x');
  });

  it('非http系や不正URLは null', () => {
    expect(resolveResultUrl('javascript:alert(1)')).toBeNull();
    expect(resolveResultUrl('')).toBeNull();
    expect(resolveResultUrl('//duckduckgo.com/l/?rut=missing-uddg')).toBeNull();
  });
});

describe('parseSearchResults', () => {
  it('HTMLエンティティを復元しタグを除去する', () => {
    const results = parseSearchResults(SAMPLE_DDG_HTML, 10);
    expect(results).toHaveLength(2);
    const first = results[0];
    expect(first?.title).toBe('useActionState – React');
    expect(first?.snippet).not.toContain('<b>');
  });
});
