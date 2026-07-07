import type { ToolContext, ToolPlugin, ToolResult } from '../types';

// Lightweight wrapper around the core screenshot capability that also reports an HTTP-like status
// and writes the PNG file to the OS temp directory, returning only the path string.

const MAX_DIMENSION = 4096;

interface HttpScreenshotInput {
  url: string;
  width?: number;
  height?: number;
}

function parseInput(input: unknown): { value: HttpScreenshotInput } | { error: string } {
  if (input === null || typeof input !== 'object') {
    return { error: 'input はオブジェクトで指定すること' };
  }

  const obj = input as { [key: string]: unknown };
  const url = obj.url;
  if (typeof url !== 'string' || url.trim() === '') {
    return { error: 'url は空でない文字列で指定すること' };
  }

  const result: HttpScreenshotInput = { url: url.trim() };

  const width = obj.width;
  if (typeof width === 'number') {
    const w = Math.min(Math.max(Math.round(width), 320), MAX_DIMENSION);
    result.width = w;
  }

  const height = obj.height;
  if (typeof height === 'number') {
    const h = Math.min(Math.max(Math.round(height), 240), MAX_DIMENSION);
    result.height = h;
  }

  return { value: result };
}

function buildJsonResult(payload: unknown): ToolResult {
  return { content: JSON.stringify(payload) };
}

export default {
  name: 'http_screenshot',
  description:
    '指定URLのページを開いてスクリーンショットを撮り、HTTPステータスとスクリーンショットPNGファイルのパスをJSON文字列で返す。既存の screenshot コンテキストAPIを利用し、外部プロセスは使わない。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '対象URL(http/https のみを想定)' },
      width: { type: 'integer', description: 'viewport幅(任意、最大4096)' },
      height: { type: 'integer', description: 'viewport高さ(任意、最大4096)' },
    },
    required: ['url'],
  },
  risk: 'safe',
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(input);
    if ('error' in parsed) {
      return buildJsonResult({ ok: false, status: 0, error: parsed.error });
    }

    if (!ctx.screenshot) {
      return buildJsonResult({ ok: false, status: 0, error: 'この実行コンテキストではスクリーンショットを撮れない(screenshot 未注入)' });
    }

    const value = parsed.value;

    let url: URL;
    try {
      url = new URL(value.url);
    } catch {
      return buildJsonResult({ ok: false, status: 0, error: `URLとして解釈できない: ${value.url}` });
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return buildJsonResult({ ok: false, status: 0, error: `http/https 以外のスキームは拒否: ${url.protocol}` });
    }

    const width = value.width;
    const height = value.height;

    try {
      const shot = await ctx.screenshot.capture(url.href, width, height);

      // data は base64 文字列を想定。OSの一時ディレクトリに PNG として書き出す。
      const os = await import('os');
      const path = await import('path');
      const fs = await import('fs/promises');

      const tmpDir = os.tmpdir();
      const fileName = `amateras-http-screenshot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
      const filePath = path.join(tmpDir, fileName);

      const buffer = Buffer.from(shot.data, 'base64');
      await fs.writeFile(filePath, buffer);

      const resultPayload = {
        ok: true,
        status: 200,
        screenshotPath: filePath,
      };
      return buildJsonResult(resultPayload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildJsonResult({ ok: false, status: 0, error: `スクリーンショット失敗(${url.href}): ${message}` });
    }
  },
} satisfies ToolPlugin;
