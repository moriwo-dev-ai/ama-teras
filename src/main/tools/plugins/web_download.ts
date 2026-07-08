import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { DynamicApprovalPolicy, ToolContext, ToolPlugin, ToolResult } from '../types';

// web_download: URLからファイルをワークスペース内へダウンロードする転送系ツール。
// 安全要件:
// - 保存先はワークスペース内の相対パスのみ(絶対パス・「..」による脱出は拒否)
// - 実行は必ずユーザー承認制(dynamicApproval で常に required:true・セッション許可なし)
// - 既存ファイルは overwrite:true 指定がない限り上書きしない
// - サイズ上限(既定100MB)超過時は中断してエラー
// - 一時ファイル(.part)へ書き込み、完了時にリネームする

const MAX_BYTES = 100 * 1024 * 1024; // 100MB
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; AMA-teras-agent/1.0) web_download';

interface DownloadInput {
  url: string;
  dest: string;
  overwrite: boolean;
  timeout_ms: number;
}

function parseInput(input: unknown): { value: DownloadInput } | { error: string } {
  if (input === null || typeof input !== 'object') {
    return { error: 'input はオブジェクトで指定すること' };
  }
  const obj = input as { [key: string]: unknown };

  const url = obj.url;
  if (typeof url !== 'string' || url.trim() === '') {
    return { error: 'url は空でない文字列で指定すること' };
  }
  const dest = obj.dest;
  if (typeof dest !== 'string' || dest.trim() === '') {
    return { error: 'dest は空でない文字列で指定すること' };
  }
  let overwrite = false;
  if (obj.overwrite !== undefined) {
    if (typeof obj.overwrite !== 'boolean') {
      return { error: 'overwrite は boolean で指定すること' };
    }
    overwrite = obj.overwrite;
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (obj.timeout_ms !== undefined) {
    if (typeof obj.timeout_ms !== 'number' || !Number.isFinite(obj.timeout_ms)) {
      return { error: 'timeout_ms は数値で指定すること' };
    }
    timeoutMs = Math.min(Math.max(Math.round(obj.timeout_ms), 1_000), MAX_TIMEOUT_MS);
  }
  return { value: { url: url.trim(), dest: dest.trim(), overwrite, timeout_ms: timeoutMs } };
}

function parseUrl(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `URLとして解釈できない: ${raw}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `http/https 以外のスキームは拒否: ${url.protocol}` };
  }
  return { url };
}

/** ワークスペース内の相対パスへ解決する。絶対パス・「..」脱出は拒否 */
export function resolveWorkspacePath(
  cwd: string,
  raw: string,
): { abs: string; rel: string } | { error: string } {
  if (isAbsolute(raw)) {
    return { error: 'absolute path is not allowed; use a workspace-relative path' };
  }
  const abs = resolve(cwd, raw);
  const rel = relative(cwd, abs).replaceAll('\\', '/');
  if (rel === '' || rel === '..' || rel.startsWith('../')) {
    return { error: 'path outside workspace is not allowed' };
  }
  return { abs, rel };
}

function writeAllowed(abs: string, ctx: ToolContext): boolean {
  if (!ctx.writeAllowlist) return true;
  const rel = relative(ctx.cwd, abs).replaceAll('\\', '/');
  if (rel.startsWith('..')) return false;
  return ctx.writeAllowlist.some((p) => {
    const prefix = p.replaceAll('\\', '/').replace(/\/+$/, '');
    return rel === prefix || rel.startsWith(`${prefix}/`);
  });
}

/** ctx.signal とタイムアウトを合成した AbortSignal を作る */
function makeCombinedSignal(
  parent: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout: ${timeoutMs}ms 以内に完了しなかった`)),
    timeoutMs,
  );
  const onAbort = () =>
    controller.abort(parent.reason instanceof Error ? parent.reason : new Error('aborted'));
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function jsonResult(payload: unknown, isError = false): ToolResult {
  return { content: JSON.stringify(payload), isError: isError ? true : undefined };
}

function failure(error: string): ToolResult {
  return jsonResult({ downloaded: false, error }, true);
}

export default {
  name: 'web_download',
  description:
    'URLからファイルをローカルへダウンロードする(HTTP GET)。保存先 dest はワークスペース内の相対パスのみ許可。既存ファイルは overwrite:true がない限り上書きしない。サイズ上限100MB。一時ファイルに書いてから完了時にリネームする。結果として {downloaded, path, bytes, sha256, contentType} をJSONで返す。実行は必ずユーザー承認制。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'ダウンロード元URL(http/https のみ)' },
      dest: {
        type: 'string',
        description: '保存先パス(ワークスペース内の相対パスのみ。絶対パス・「..」脱出は拒否)',
      },
      overwrite: {
        type: 'boolean',
        description: '既存ファイルを上書きする(既定 false。未指定で既存ならエラー)',
      },
      timeout_ms: {
        type: 'integer',
        description: `タイムアウト(ミリ秒、既定${DEFAULT_TIMEOUT_MS}、最大${MAX_TIMEOUT_MS})`,
      },
    },
    required: ['url', 'dest'],
    additionalProperties: false,
  },
  risk: 'write',
  pathParams: ['dest'],
  warnings: [
    'ネットワークアクセスを行う(指定URLへのHTTP GETリクエスト。リダイレクト追従あり)',
    'ローカルファイルシステムへ書き込む(ワークスペース内のみ)',
  ],
  dynamicApproval(input: unknown): DynamicApprovalPolicy {
    const parsed = parseInput(input);
    if ('error' in parsed) return { error: parsed.error };
    const target = parseUrl(parsed.value.url);
    if ('error' in target) return { error: target.error };
    // 副作用のある転送操作なので常に承認必須(sessionKey なし = 毎回承認)
    return {
      required: true,
      warnings: [
        `${target.url.href} からダウンロードし、ワークスペース内 ${parsed.value.dest} へ保存します(上限100MB)`,
      ],
      auditPaths: [target.url.href, parsed.value.dest],
    };
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(input);
    if ('error' in parsed) return failure(parsed.error);
    const { url: rawUrl, dest: rawDest, overwrite, timeout_ms: timeoutMs } = parsed.value;

    const target = parseUrl(rawUrl);
    if ('error' in target) return failure(target.error);

    const destPath = resolveWorkspacePath(ctx.cwd, rawDest);
    if ('error' in destPath) return failure(destPath.error);
    if (!writeAllowed(destPath.abs, ctx)) {
      return failure(`書き込み許可外のパス: ${destPath.rel}(許可: ${ctx.writeAllowlist?.join(', ')})`);
    }

    if (!overwrite && (await fileExists(destPath.abs))) {
      return failure('destination exists; pass overwrite:true');
    }

    ctx.log(`web_download: GET ${target.url.href} -> ${destPath.rel}`);
    const { signal, cleanup } = makeCombinedSignal(ctx.signal, timeoutMs);

    let response: Response;
    try {
      response = await fetch(target.url.href, {
        method: 'GET',
        redirect: 'follow',
        signal,
        headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      });
    } catch (err) {
      cleanup();
      const message = err instanceof Error ? err.message : String(err);
      return failure(`取得失敗: ${message}`);
    }

    // 一時ファイルへ書き、完了時にリネームする
    const tmpAbs = resolve(
      dirname(destPath.abs),
      `.${basename(destPath.abs)}.${randomBytes(6).toString('hex')}.part`,
    );
    let tmpCreated = false;
    try {
      if (response.status >= 400) {
        await response.body?.cancel().catch(() => {});
        return failure(`HTTP ${response.status}`);
      }
      const contentType = response.headers.get('content-type');

      // Content-Length が明示されていれば先に上限チェック
      const lenRaw = response.headers.get('content-length');
      if (lenRaw !== null && /^\d+$/.test(lenRaw.trim()) && Number.parseInt(lenRaw.trim(), 10) > MAX_BYTES) {
        await response.body?.cancel().catch(() => {});
        return failure('size limit exceeded (100MB)');
      }

      await mkdir(dirname(destPath.abs), { recursive: true });
      const handle = await open(tmpAbs, 'w');
      tmpCreated = true;
      const hash = createHash('sha256');
      let bytes = 0;
      try {
        const body = response.body;
        if (body !== null) {
          const reader = body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value === undefined) continue;
              const chunk = Buffer.from(value);
              bytes += chunk.length;
              if (bytes > MAX_BYTES) {
                await reader.cancel().catch(() => {});
                return failure('size limit exceeded (100MB)');
              }
              hash.update(chunk);
              await handle.write(chunk);
            }
          } finally {
            reader.releaseLock();
          }
        }
      } finally {
        await handle.close();
      }

      if (overwrite) {
        await rm(destPath.abs, { force: true }); // Windows では既存宛先への rename が失敗するため
      }
      await rename(tmpAbs, destPath.abs);
      tmpCreated = false;
      ctx.log(`web_download: saved ${destPath.rel} (${bytes} bytes)`);
      return jsonResult({
        downloaded: true,
        path: destPath.rel,
        bytes,
        sha256: hash.digest('hex'),
        contentType: contentType ?? 'unknown',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failure(`ダウンロード失敗: ${message}`);
    } finally {
      cleanup();
      if (tmpCreated) {
        await rm(tmpAbs, { force: true }).catch(() => {});
      }
    }
  },
} satisfies ToolPlugin;
