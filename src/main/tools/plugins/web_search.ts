import type { ToolPlugin, ToolContext, ToolResult } from '../types';

// web_search: クエリ文字列でWeb検索し、上位結果の {title, url, snippet} 配列を返す読み取り専用ツール。
// APIキー不要の DuckDuckGo HTML エンドポイント(https://html.duckduckgo.com/html/)を
// GET 1回だけ叩いて結果をパースする。認証ヘッダ・Cookieは扱わない。

const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 20;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; AMA-teras-agent/1.0) web_search';

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

interface WebSearchInput {
  query: string;
  max_results: number;
  timeout_ms: number;
}

function parseInput(input: unknown): { value: WebSearchInput } | { error: string } {
  if (input === null || typeof input !== 'object') {
    return { error: 'input はオブジェクトで指定すること' };
  }
  const obj = input as { [key: string]: unknown };

  const query = obj.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { error: 'query は空でない文字列で指定すること' };
  }

  let maxResults = DEFAULT_MAX_RESULTS;
  if (obj.max_results !== undefined) {
    if (typeof obj.max_results !== 'number' || !Number.isFinite(obj.max_results)) {
      return { error: 'max_results は数値で指定すること' };
    }
    maxResults = Math.min(Math.max(Math.round(obj.max_results), 1), MAX_MAX_RESULTS);
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (obj.timeout_ms !== undefined) {
    if (typeof obj.timeout_ms !== 'number' || !Number.isFinite(obj.timeout_ms)) {
      return { error: 'timeout_ms は数値で指定すること' };
    }
    timeoutMs = Math.min(Math.max(Math.round(obj.timeout_ms), 1_000), MAX_TIMEOUT_MS);
  }

  return { value: { query: query.trim(), max_results: maxResults, timeout_ms: timeoutMs } };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '\u2019',
  lsquo: '\u2018',
  rdquo: '\u201d',
  ldquo: '\u201c',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : whole;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * DuckDuckGo の結果リンクはリダイレクトURL(//duckduckgo.com/l/?uddg=<encoded>&...)の
 * ことがあるため、uddg パラメータから実URLを復元する。
 */
export function resolveResultUrl(href: string): string | null {
  const trimmed = decodeEntities(href).trim();
  if (trimmed === '') return null;
  let candidate = trimmed;
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname.startsWith('/l/')) {
    const uddg = parsed.searchParams.get('uddg');
    if (uddg === null || uddg === '') return null;
    try {
      const real = new URL(uddg);
      if (real.protocol !== 'http:' && real.protocol !== 'https:') return null;
      return real.href;
    } catch {
      return null;
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.href;
}

/**
 * DuckDuckGo HTML 版の検索結果ページから {title, url, snippet} を抽出する。
 * result__a(タイトルリンク)と result__snippet(概要)のクラス名に依存する。
 */
export function parseSearchResults(html: string, maxResults: number): SearchResultItem[] {
  const results: SearchResultItem[] = [];
  const seen = new Set<string>();

  const anchorRe =
    /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const anchorReAlt =
    /<a\b[^>]*href="([^"]*)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe =
    /<(?:a|td|div|span)\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)>/gi;

  // スニペットは出現順に対応付ける(タイトルと同じ result ブロック内で連続して現れる)
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) {
    snippets.push(sm[1] !== undefined ? stripTags(sm[1]) : '');
  }

  const collect = (re: RegExp): void => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && results.length < maxResults) {
      const href = m[1];
      const titleHtml = m[2];
      if (href === undefined || titleHtml === undefined) continue;
      const url = resolveResultUrl(href);
      if (url === null || seen.has(url)) continue;
      const title = stripTags(titleHtml);
      if (title === '') continue;
      seen.add(url);
      const snippet = snippets[results.length] ?? '';
      results.push({ title, url, snippet });
    }
  };

  collect(anchorRe);
  if (results.length === 0) collect(anchorReAlt);
  return results;
}

function makeCombinedSignal(
  parent: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout: ${timeoutMs}ms 以内に応答がなかった`)), timeoutMs);
  const onAbort = () => controller.abort(parent.reason instanceof Error ? parent.reason : new Error('aborted'));
  if (parent.aborted) {
    onAbort();
  } else {
    parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
  };
}

function jsonResult(payload: unknown, isError = false): ToolResult {
  return { content: JSON.stringify(payload), isError: isError ? true : undefined };
}

export default {
  name: 'web_search',
  description:
    'クエリ文字列でWeb検索し、上位結果の {title, url, snippet} の配列をJSONで返す読み取り専用ツール。max_results で件数指定可(既定5)。1呼び出しにつき検索リクエスト1回だけを行う(DuckDuckGo HTML版をGET)。認証情報は扱わない。ページの中身が必要なら結果URLを web_fetch で取得すること。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '検索クエリ' },
      max_results: {
        type: 'integer',
        description: `返す最大件数(既定${DEFAULT_MAX_RESULTS}、最大${MAX_MAX_RESULTS})`,
      },
      timeout_ms: {
        type: 'integer',
        description: `タイムアウト(ミリ秒、既定${DEFAULT_TIMEOUT_MS}、最大${MAX_TIMEOUT_MS})`,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  risk: 'safe',
  tags: ['Web操作', '検索'],
  warnings: ['ネットワークアクセスを行う(DuckDuckGo検索エンドポイントへのHTTP GETリクエスト1回)'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(input);
    if ('error' in parsed) {
      return jsonResult({ error: parsed.error }, true);
    }
    const { query, max_results: maxResults, timeout_ms: timeoutMs } = parsed.value;

    const endpoint = new URL('https://html.duckduckgo.com/html/');
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('kl', 'wt-wt'); // 地域ニュートラル

    ctx.log(`web_search: "${query}" (max ${maxResults})`);
    const { signal, cleanup } = makeCombinedSignal(ctx.signal, timeoutMs);

    let html: string;
    let status: number;
    try {
      const response = await fetch(endpoint.href, {
        method: 'GET',
        redirect: 'follow',
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'ja,en;q=0.8',
        },
      });
      status = response.status;
      html = await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResult({ query, error: `検索リクエスト失敗: ${message}` }, true);
    } finally {
      cleanup();
    }

    if (status < 200 || status >= 300) {
      return jsonResult(
        { query, status, error: `検索エンドポイントが status ${status} を返した`, source: endpoint.href },
        true,
      );
    }

    const results = parseSearchResults(html, maxResults);
    return jsonResult({
      query,
      source: endpoint.href,
      results,
      note:
        results.length === 0
          ? '結果が0件。クエリを変えるか、検索エンジン側のレイアウト変更/ボット判定の可能性がある'
          : undefined,
    });
  },
} satisfies ToolPlugin;
