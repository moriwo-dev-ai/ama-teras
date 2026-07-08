import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { DynamicApprovalPolicy, ToolContext, ToolPlugin, ToolResult } from '../types';

// web_upload: ローカルファイルを指定URLへHTTPでアップロードする転送系ツール。
// 安全要件:
// - 対象ファイルはワークスペース内のみ(絶対パス・「..」による脱出は拒否)
// - 実行は必ずユーザー承認制(dynamicApproval で常に required:true・セッション許可なし)
// - Authorization 等の秘密情報ヘッダの値は結果・ログにエコーしない(マスクする)
// - fieldName 指定時は multipart/form-data、省略時は生ボディで送る

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_CHARS = 2_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; AMA-teras-agent/1.0) web_upload';

/** 値をマスクすべき秘密情報ヘッダ(小文字で比較) */
const SENSITIVE_HEADER_PATTERNS = ['authorization', 'cookie', 'token', 'secret', 'api-key', 'apikey', 'x-auth'];

export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADER_PATTERNS.some((p) => lower.includes(p));
}

export function maskHeaderForDisplay(name: string, value: string): string {
  return isSensitiveHeader(name) ? `${name}: ***masked***` : `${name}: ${value}`;
}

interface UploadInput {
  url: string;
  file: string;
  method: 'POST' | 'PUT';
  fieldName: string | null;
  headers: Record<string, string>;
  timeout_ms: number;
}

function parseInput(input: unknown): { value: UploadInput } | { error: string } {
  if (input === null || typeof input !== 'object') {
    return { error: 'input はオブジェクトで指定すること' };
  }
  const obj = input as { [key: string]: unknown };

  const url = obj.url;
  if (typeof url !== 'string' || url.trim() === '') {
    return { error: 'url は空でない文字列で指定すること' };
  }
  const file = obj.file;
  if (typeof file !== 'string' || file.trim() === '') {
    return { error: 'file は空でない文字列で指定すること' };
  }

  let method: 'POST' | 'PUT' = 'POST';
  if (obj.method !== undefined) {
    if (obj.method !== 'POST' && obj.method !== 'PUT') {
      return { error: 'method は "POST" または "PUT" で指定すること' };
    }
    method = obj.method;
  }

  let fieldName: string | null = null;
  if (obj.fieldName !== undefined) {
    if (typeof obj.fieldName !== 'string' || obj.fieldName.trim() === '') {
      return { error: 'fieldName は空でない文字列で指定すること' };
    }
    fieldName = obj.fieldName.trim();
  }

  const headers: Record<string, string> = {};
  if (obj.headers !== undefined) {
    if (obj.headers === null || typeof obj.headers !== 'object' || Array.isArray(obj.headers)) {
      return { error: 'headers は文字列値のオブジェクトで指定すること' };
    }
    for (const [k, v] of Object.entries(obj.headers as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        return { error: `headers の値は文字列で指定すること(${k} が不正)` };
      }
      if (!/^[\w-]+$/.test(k)) {
        return { error: `ヘッダ名として不正: ${k}` };
      }
      headers[k] = v;
    }
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (obj.timeout_ms !== undefined) {
    if (typeof obj.timeout_ms !== 'number' || !Number.isFinite(obj.timeout_ms)) {
      return { error: 'timeout_ms は数値で指定すること' };
    }
    timeoutMs = Math.min(Math.max(Math.round(obj.timeout_ms), 1_000), MAX_TIMEOUT_MS);
  }

  return { value: { url: url.trim(), file: file.trim(), method, fieldName, headers, timeout_ms: timeoutMs } };
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
function resolveWorkspacePath(
  cwd: string,
  raw: string,
): { abs: string; rel: string } | { error: string } {
  if (isAbsolute(raw)) {
    return { error: 'file path outside workspace is not allowed' };
  }
  const abs = resolve(cwd, raw);
  const rel = relative(cwd, abs).replaceAll('\\', '/');
  if (rel === '' || rel === '..' || rel.startsWith('../')) {
    return { error: 'file path outside workspace is not allowed' };
  }
  return { abs, rel };
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

/** multipart/form-data のボディを組み立てる(FormData のファイル名エンコード差異を避けるため自前で構築) */
export function buildMultipartBody(
  fieldName: string,
  fileName: string,
  fileData: Buffer,
): { body: Buffer; contentType: string } {
  const boundary = `----amateras-${randomBytes(12).toString('hex')}`;
  const safeName = fileName.replaceAll('"', '_').replaceAll('\r', '_').replaceAll('\n', '_');
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName.replaceAll('"', '_')}"; filename="${safeName}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    body: Buffer.concat([Buffer.from(head, 'utf8'), fileData, Buffer.from(tail, 'utf8')]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function jsonResult(payload: unknown, isError = false): ToolResult {
  return { content: JSON.stringify(payload), isError: isError ? true : undefined };
}

function failure(error: string): ToolResult {
  return jsonResult({ uploaded: false, error }, true);
}

export default {
  name: 'web_upload',
  description:
    'ローカルファイルを指定URLへHTTPでアップロードする。fieldName 指定時は multipart/form-data、省略時は生ボディで送る。対象ファイルはワークスペース内のみ(絶対パス・「..」脱出は拒否)。結果として {uploaded, status, responseText(先頭のみ), headersUsed} をJSONで返す。Authorization 等の秘密情報ヘッダの値は結果・ログにエコーしない(マスクする)。実行は必ずユーザー承認制。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'アップロード先URL(http/https のみ)' },
      file: {
        type: 'string',
        description: 'アップロードするファイル(ワークスペース内の相対パスのみ)',
      },
      method: { type: 'string', enum: ['POST', 'PUT'], description: 'HTTPメソッド(既定 POST)' },
      fieldName: {
        type: 'string',
        description: 'multipart/form-data のフィールド名。省略時はファイル内容を生ボディとして送る',
      },
      headers: {
        type: 'object',
        description:
          '追加HTTPヘッダ(例: {"Authorization": "Bearer ..."}). 秘密情報の値は結果にマスクして返す',
        additionalProperties: true,
      },
      timeout_ms: {
        type: 'integer',
        description: `タイムアウト(ミリ秒、既定${DEFAULT_TIMEOUT_MS}、最大${MAX_TIMEOUT_MS})`,
      },
    },
    required: ['url', 'file'],
    additionalProperties: false,
  },
  risk: 'exec',
  tags: ['Web操作', 'ファイル操作'],
  pathParams: ['file'],
  warnings: [
    'ネットワークアクセスを行う(指定URLへローカルファイルの内容を送信する)',
    'ファイル内容が外部サーバへ送信されるため、送信先URLと対象ファイルを必ず確認すること',
  ],
  dynamicApproval(input: unknown): DynamicApprovalPolicy {
    const parsed = parseInput(input);
    if ('error' in parsed) return { error: parsed.error };
    const target = parseUrl(parsed.value.url);
    if ('error' in target) return { error: target.error };
    const headerNames = Object.keys(parsed.value.headers);
    const warnings = [
      `${parsed.value.file} を ${parsed.value.method} で ${target.url.href} へアップロードします` +
        (parsed.value.fieldName !== null
          ? `(multipart フィールド名: ${parsed.value.fieldName})`
          : '(生ボディ)'),
    ];
    if (headerNames.length > 0) {
      warnings.push(`追加ヘッダ: ${headerNames.join(', ')}(秘密情報の値は結果にマスクされます)`);
    }
    // 副作用のある転送操作なので常に承認必須(sessionKey なし = 毎回承認)
    return {
      required: true,
      warnings,
      auditPaths: [target.url.href, parsed.value.file],
    };
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(input);
    if ('error' in parsed) return failure(parsed.error);
    const { url: rawUrl, file, method, fieldName, headers, timeout_ms: timeoutMs } = parsed.value;

    const target = parseUrl(rawUrl);
    if ('error' in target) return failure(target.error);

    const filePath = resolveWorkspacePath(ctx.cwd, file);
    if ('error' in filePath) return failure(filePath.error);

    let fileData: Buffer;
    try {
      const info = await stat(filePath.abs);
      if (!info.isFile()) {
        return failure(`ファイルではない: ${filePath.rel}`);
      }
      if (info.size > MAX_UPLOAD_BYTES) {
        return failure('size limit exceeded (100MB)');
      }
      fileData = await readFile(filePath.abs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failure(`ファイルを読めない: ${filePath.rel} (${message})`);
    }

    // リクエストヘッダを構築(content-type はボディ形式が決める。ユーザー指定があれば尊重)
    const requestHeaders: Record<string, string> = { 'user-agent': USER_AGENT };
    const headersUsed: string[] = [];
    let userContentType: string | null = null;
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'content-type') {
        userContentType = v;
      }
      requestHeaders[k] = v;
      headersUsed.push(maskHeaderForDisplay(k, v));
    }

    let body: Buffer;
    if (fieldName !== null) {
      const multipart = buildMultipartBody(fieldName, basename(filePath.abs), fileData);
      body = multipart.body;
      if (userContentType === null) {
        requestHeaders['Content-Type'] = multipart.contentType;
      }
    } else {
      body = fileData;
      if (userContentType === null) {
        requestHeaders['Content-Type'] = 'application/octet-stream';
      }
    }

    // ログにはヘッダ値を出さない(マスク済み表示のみ)
    ctx.log(`web_upload: ${method} ${target.url.href} file=${filePath.rel} (${fileData.length} bytes)`);
    if (headersUsed.length > 0) {
      ctx.log(`web_upload: headers ${headersUsed.join(' / ')}`);
    }

    const { signal, cleanup } = makeCombinedSignal(ctx.signal, timeoutMs);
    try {
      const response = await fetch(target.url.href, {
        method,
        headers: requestHeaders,
        body: new Uint8Array(body),
        signal,
      });
      const text = await response.text();
      const truncated = text.length > MAX_RESPONSE_CHARS;
      return jsonResult({
        uploaded: response.status < 400,
        status: response.status,
        responseText: truncated ? text.slice(0, MAX_RESPONSE_CHARS) : text,
        responseTruncated: truncated || undefined,
        headersUsed,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failure(`アップロード失敗: ${message}`);
    } finally {
      cleanup();
    }
  },
} satisfies ToolPlugin;
