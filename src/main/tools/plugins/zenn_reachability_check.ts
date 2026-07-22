import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * Zenn の「content 側は published:true だが Zenn 上では未反映」を検出する葉ツール。
 * slug ごとに Zenn 実 URL へ HTTP で到達性を確認し、読めない(200 以外/接続失敗)
 * ものだけを god-failure/metrics 形式の受け箱メッセージとして返す。
 * 外部への投稿は行わない(読み取り確認のみ)。
 */

export type ZennSlugReachability = {
  slug: string;
  url: string;
  /** 到達性: ok=読める(2xx) / http_error=HTTP応答はあるが読めない / unreachable=接続自体に失敗 */
  status: 'ok' | 'http_error' | 'unreachable';
  /** HTTP ステータスコード(unreachable のときは null) */
  statusCode: number | null;
  detail: string;
};

const FETCH_TIMEOUT_MS = 10_000;
/** 1回の呼び出しで確認できる slug の上限(過剰な外部アクセスを防ぐ) */
const MAX_SLUGS = 30;

/** slug 文字列として妥当か(Zenn の記事/本 slug は英小文字・数字・ハイフン・アンダースコア) */
export function isValidZennSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(slug) && slug.length <= 200;
}

/** username + slug から Zenn 実 URL を組み立てる */
export function buildZennUrl(username: string, slug: string, kind: 'articles' | 'books'): string {
  return `https://zenn.dev/${encodeURIComponent(username)}/${kind}/${encodeURIComponent(slug)}`;
}

/** HTTP ステータスから到達性を解釈する(純関数)。2xx のみ ok、それ以外は読めない */
export function interpretHttpStatus(statusCode: number): { status: 'ok' | 'http_error'; detail: string } {
  if (statusCode >= 200 && statusCode < 300) {
    return { status: 'ok', detail: `HTTP ${statusCode}: 読める` };
  }
  if (statusCode === 404) {
    return { status: 'http_error', detail: `HTTP 404: Zenn 上に存在しない(未反映の可能性)` };
  }
  return { status: 'http_error', detail: `HTTP ${statusCode}: 読めない` };
}

/** 受け箱(god-failure/metrics)に出すメッセージ本文を組み立てる(純関数)。読めないものだけを出す */
export function buildInboxReport(results: ZennSlugReachability[]): string {
  const ng = results.filter((r) => r.status !== 'ok');
  const okCount = results.length - ng.length;
  const lines: string[] = [];
  lines.push(`Zenn 到達性チェック: 全${results.length}件中 ok=${okCount} / 読めない=${ng.length}件`);
  if (ng.length > 0) {
    lines.push('');
    lines.push('## god-failure/metrics 受け箱(読めない slug のみ)');
    for (const r of ng) {
      lines.push(`- slug: ${r.slug}`);
      lines.push(`  url: ${r.url}`);
      lines.push(`  status: ${r.status}${r.statusCode !== null ? ` (${r.statusCode})` : ''}`);
      lines.push(`  detail: ${r.detail}`);
      lines.push('  category: god-failure/metrics');
    }
  } else {
    lines.push('受け箱に出す項目はない(すべて読める)');
  }
  return lines.join('\n');
}

/** 実際に Zenn 実 URL へ GET して到達性を確かめる(外部ネットワークアクセス) */
async function checkOne(username: string, slug: string, kind: 'articles' | 'books', signal: AbortSignal): Promise<ZennSlugReachability> {
  const url = buildZennUrl(username, slug, kind);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  // 親 signal が切れたら子も切る
  const onAbort = (): void => controller.abort();
  if (signal.aborted) {
    clearTimeout(timer);
    return { slug, url, status: 'unreachable', statusCode: null, detail: 'キャンセルされた' };
  }
  signal.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'AMA-teras zenn_reachability_check (read-only)' },
    });
    const interpreted = interpretHttpStatus(res.status);
    // 本文は読まない(到達性のみ)。body を消費せず閉じるため cancel を試みる
    try {
      await res.body?.cancel();
    } catch {
      /* 無視 */
    }
    return { slug, url, status: interpreted.status, statusCode: res.status, detail: interpreted.detail };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const detail = controller.signal.aborted ? 'タイムアウトまたはキャンセル' : `接続失敗: ${msg}`;
    return { slug, url, status: 'unreachable', statusCode: null, detail };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

export default {
  name: 'zenn_reachability_check',
  description:
    'Zenn の「content 側は published:true だが Zenn 上では未反映(読めない)」を自動検出する。' +
    'slug ごとに Zenn 実 URL(https://zenn.dev/<username>/articles/<slug> 等)へ到達性を確認し、' +
    '読める(2xx)ものは通常の公開済みとして扱い、読めない(404 等 / 接続失敗)ものだけを ' +
    'god-failure/metrics 形式の受け箱メッセージとして返す。' +
    '外部への投稿は行わない(読み取り確認のみ)。omoi-kami / saruta-hiko からの検査用。',
  inputSchema: {
    type: 'object',
    properties: {
      username: { type: 'string', description: 'Zenn のユーザー名(URL の https://zenn.dev/<username>/ の部分)' },
      slugs: { type: 'array', description: '確認する slug の配列(最大30件)', items: { type: 'string' } },
      kind: {
        type: 'string',
        enum: ['articles', 'books'],
        description: 'URL の種別。省略=articles',
      },
    },
    required: ['username', 'slugs'],
    additionalProperties: false,
  },
  risk: 'safe',
  tags: ['Web操作'],
  warnings: ['外部ネットワーク(zenn.dev)へ読み取り専用のHTTPリクエストを送信します'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const obj = input as { username?: unknown; slugs?: unknown; kind?: unknown };
    if (typeof obj.username !== 'string' || obj.username.trim() === '') {
      return { content: 'username は空でない文字列で指定すること', isError: true };
    }
    if (!Array.isArray(obj.slugs) || obj.slugs.length === 0) {
      return { content: 'slugs は1件以上の配列で指定すること', isError: true };
    }
    if (obj.slugs.length > MAX_SLUGS) {
      return { content: `slugs は最大${MAX_SLUGS}件まで`, isError: true };
    }
    const slugs: string[] = [];
    for (const s of obj.slugs) {
      if (typeof s !== 'string' || !isValidZennSlug(s)) {
        return { content: `不正な slug が含まれている: ${String(s)}`, isError: true };
      }
      slugs.push(s);
    }
    if (obj.kind !== undefined && obj.kind !== 'articles' && obj.kind !== 'books') {
      return { content: 'kind は "articles" / "books" のいずれか', isError: true };
    }
    const kind: 'articles' | 'books' = obj.kind === 'books' ? 'books' : 'articles';

    const results: ZennSlugReachability[] = [];
    for (const slug of slugs) {
      if (ctx.signal.aborted) {
        results.push({ slug, url: buildZennUrl(obj.username, slug, kind), status: 'unreachable', statusCode: null, detail: 'キャンセルされた' });
        continue;
      }
      ctx.log(`Zenn 到達性チェック: ${slug}`);
      // 直列で1件ずつ(対象は読み取りのみ・過剰な並列アクセスを避ける)
      results.push(await checkOne(obj.username, slug, kind, ctx.signal));
    }

    const report = buildInboxReport(results);
    // 読めない slug の検出はツールの障害ではなく「検出結果」なので isError は立てない。
    // エラー扱いにするとスモーク/呼び出し側が失敗と誤認し、受け箱本文を落とすため。
    return { content: report };
  },
} satisfies ToolPlugin;
