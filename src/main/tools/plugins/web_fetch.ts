import type { ToolPlugin, ToolContext, ToolResult } from '../types';

// web_fetch: 指定URLをHTTP GETで取得し、タイトル・本文テキスト(HTMLタグ除去済み)・
// 主要リンク一覧を返す読み取り専用ツール。
// 安全要件: GETのみ / 認証ヘッダ・Cookieは扱わない / 1呼び出し1リクエスト(リダイレクト追従は除く) /
// バイナリは本文をダウンロードせず content-type とサイズだけ返す。

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CHARS = 20_000;
const MAX_MAX_CHARS = 100_000;
const MAX_BODY_BYTES = 2_000_000; // 本文読み込みの上限(それ以上は打ち切って truncated)
const MAX_LINKS = 50;
const USER_AGENT = 'Mozilla/5.0 (compatible; AMA-teras-agent/1.0; +https://github.com/ama-teras) web_fetch';

interface WebFetchInput {
  url: string;
  max_chars: number;
  timeout_ms: number;
}

function parseInput(input: unknown): { value: WebFetchInput } | { error: string } {
  if (input === null || typeof input !== 'object') {
    return { error: 'input はオブジェクトで指定すること' };
  }
  const obj = input as { [key: string]: unknown };

  const url = obj.url;
  if (typeof url !== 'string' || url.trim() === '') {
    return { error: 'url は空でない文字列で指定すること' };
  }

  let maxChars = DEFAULT_MAX_CHARS;
  if (obj.max_chars !== undefined) {
    if (typeof obj.max_chars !== 'number' || !Number.isFinite(obj.max_chars)) {
      return { error: 'max_chars は数値で指定すること' };
    }
    maxChars = Math.min(Math.max(Math.round(obj.max_chars), 100), MAX_MAX_CHARS);
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (obj.timeout_ms !== undefined) {
    if (typeof obj.timeout_ms !== 'number' || !Number.isFinite(obj.timeout_ms)) {
      return { error: 'timeout_ms は数値で指定すること' };
    }
    timeoutMs = Math.min(Math.max(Math.round(obj.timeout_ms), 1_000), MAX_TIMEOUT_MS);
  }

  return { value: { url: url.trim(), max_chars: maxChars, timeout_ms: timeoutMs } };
}

/** ctx.signal とタイムアウトを合成した AbortSignal を作る */
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

const TEXTUAL_TYPE_PATTERNS = ['json', 'xml', 'javascript', 'ecmascript', 'x-www-form-urlencoded', 'svg'];

/** content-type がテキスト系(本文を取得してよい)かどうか */
export function isTextualContentType(contentType: string | null): boolean {
  if (contentType === null || contentType.trim() === '') return true; // 不明なら小さく読んで判断する
  const ct = contentType.toLowerCase();
  if (ct.startsWith('text/')) return true;
  return TEXTUAL_TYPE_PATTERNS.some((p) => ct.includes(p));
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
  copy: '©',
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

/** HTMLから <title> を抜き出す(なければ null) */
function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m || m[1] === undefined) return null;
  const title = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  return title === '' ? null : title;
}

/** HTMLをプレーンテキスト化する(script/style除去 → タグ除去 → エンティティ復元 → 空白整理) */
function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ');
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote|pre)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\r\f\v]+/g, ' ');
  s = s.replace(/ ?\n ?/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** HTMLから http/https の絶対リンクを抽出する(baseUrl 基準で解決・重複排除・上限あり) */
function extractLinks(html: string, baseUrl: string, limit: number): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && links.length < limit) {
    const raw = m[2] ?? m[3];
    if (raw === undefined || raw === '') continue;
    const href = decodeEntities(raw).trim();
    if (href === '' || href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    resolved.hash = '';
    const normalized = resolved.href;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    links.push(normalized);
  }
  return links;
}

/** response body を上限バイトまで読む(超えたら打ち切って truncatedBytes=true) */
async function readBodyLimited(
  response: Response,
  maxBytes: number,
): Promise<{ buffer: Buffer; truncatedBytes: boolean }> {
  const body = response.body;
  if (body === null) {
    return { buffer: Buffer.alloc(0), truncatedBytes: false };
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncatedBytes = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const chunk = Buffer.from(value);
      total += chunk.length;
      chunks.push(chunk);
      if (total >= maxBytes) {
        truncatedBytes = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { buffer: Buffer.concat(chunks).subarray(0, maxBytes), truncatedBytes };
}

function jsonResult(payload: unknown, isError = false): ToolResult {
  return { content: JSON.stringify(payload), isError: isError ? true : undefined };
}

export default {
  name: 'web_fetch',
  description:
    '指定URLをHTTP GETで取得し、{status, url, title, text(HTMLタグ除去済み・長い場合は切り詰め), links(主要リンク), truncated} をJSONで返す読み取り専用ツール。リダイレクト追従・タイムアウトあり。バイナリ(画像/zip等)は本文をダウンロードせず contentType とサイズだけ返す。GET以外は実行せず、認証情報・Cookieは扱わない。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '取得するURL(http/https のみ)' },
      max_chars: {
        type: 'integer',
        description: `本文テキストの最大文字数(既定${DEFAULT_MAX_CHARS}、最大${MAX_MAX_CHARS}。超過分は切り詰めて truncated:true)`,
      },
      timeout_ms: {
        type: 'integer',
        description: `タイムアウト(ミリ秒、既定${DEFAULT_TIMEOUT_MS}、最大${MAX_TIMEOUT_MS})`,
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  risk: 'safe',
  warnings: ['ネットワークアクセスを行う(指定URLへのHTTP GETリクエスト1回。リダイレクト追従あり)'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(input);
    if ('error' in parsed) {
      return jsonResult({ error: parsed.error }, true);
    }
    const { url: rawUrl, max_chars: maxChars, timeout_ms: timeoutMs } = parsed.value;

    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      return jsonResult({ error: `URLとして解釈できない: ${rawUrl}` }, true);
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return jsonResult({ error: `http/https 以外のスキームは拒否: ${target.protocol}` }, true);
    }

    ctx.log(`web_fetch: GET ${target.href}`);
    const { signal, cleanup } = makeCombinedSignal(ctx.signal, timeoutMs);

    let response: Response;
    try {
      response = await fetch(target.href, {
        method: 'GET',
        redirect: 'follow',
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'accept-language': 'ja,en;q=0.8',
        },
      });
    } catch (err) {
      cleanup();
      const message = err instanceof Error ? err.message : String(err);
      return jsonResult({ url: target.href, error: `取得失敗: ${message}` }, true);
    }

    try {
      const finalUrl = response.url !== '' ? response.url : target.href;
      const contentType = response.headers.get('content-type');
      const contentLengthRaw = response.headers.get('content-length');
      const contentLength =
        contentLengthRaw !== null && /^\d+$/.test(contentLengthRaw.trim())
          ? Number.parseInt(contentLengthRaw.trim(), 10)
          : null;

      // バイナリは本文を読まない(ストリームを閉じてメタ情報だけ返す)
      if (!isTextualContentType(contentType)) {
        await response.body?.cancel().catch(() => {});
        return jsonResult({
          status: response.status,
          url: finalUrl,
          contentType: contentType ?? 'unknown',
          bytes: contentLength,
          text: null,
          title: null,
          links: [],
          truncated: false,
          note: 'binary content not fetched',
        });
      }

      const { buffer, truncatedBytes } = await readBodyLimited(response, MAX_BODY_BYTES);
      const raw = buffer.toString('utf8');
      const ct = (contentType ?? '').toLowerCase();
      const isHtml = ct.includes('html') || ct.includes('xhtml') || /^\s*<(!doctype|html)/i.test(raw);

      let title: string | null = null;
      let text: string;
      let links: string[] = [];
      if (isHtml) {
        title = extractTitle(raw);
        text = htmlToText(raw);
        links = extractLinks(raw, finalUrl, MAX_LINKS);
      } else {
        text = raw.trim();
      }

      const truncatedChars = text.length > maxChars;
      if (truncatedChars) {
        text = text.slice(0, maxChars);
      }

      return jsonResult({
        status: response.status,
        url: finalUrl,
        contentType: contentType ?? 'unknown',
        title,
        text,
        links,
        truncated: truncatedChars || truncatedBytes,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResult({ url: target.href, error: `本文の読み取りに失敗: ${message}` }, true);
    } finally {
      cleanup();
    }
  },
} satisfies ToolPlugin;
