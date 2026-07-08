import type { DynamicApprovalPolicy, ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * M14-2: URLスクリーンショット。offscreen BrowserWindow(main から ToolContext 注入)で
 * ページを開き、PNG を tool_result の画像として返す。
 * 承認ポリシー(2026-07-06 ユーザー決定):
 * - localhost / 127.0.0.1 → risk 'safe' の通常フロー(autoApprove.safe でスルー可)
 * - 外部URL → 毎回承認。「セッション中許可」は**ドメイン単位**(全外部の一括解放はしない)。
 *   自動許可された再スクショも含め、外部URLは全件 audit.jsonl に記録される
 * - http/https 以外のスキーム(file:// 等)は承認ダイアログも出さず拒否
 */

const MAX_DIMENSION = 4096;

function parseTarget(input: unknown): { url: URL } | { error: string } {
  const { url } = (input ?? {}) as { url?: unknown };
  if (typeof url !== 'string' || url.trim() === '') return { error: 'url は空でない文字列で指定すること' };
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { error: `URLとして解釈できない: ${url}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `http/https 以外のスキームは拒否: ${parsed.protocol}` };
  }
  return { url: parsed };
}

export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

export default {
  name: 'screenshot',
  description:
    '指定URLのページを開いてスクリーンショットを撮り、画像として返す。UIの見た目確認' +
    '(レイアウト・色・配置)に使う。localhost の devサーバは自動、外部URLはユーザー承認制' +
    '(セッション中許可はドメイン単位)。width/height で viewport を指定できる(既定 1280x800)。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '対象URL(http/https のみ)' },
      width: { type: 'integer', description: 'viewport幅(既定1280、最大4096)' },
      height: { type: 'integer', description: 'viewport高さ(既定800、最大4096)' },
    },
    required: ['url'],
  },
  risk: 'safe',
  tags: ['Web操作'],
  dynamicApproval(input: unknown): DynamicApprovalPolicy {
    const target = parseTarget(input);
    if ('error' in target) return { error: target.error };
    if (isLocalHost(target.url.hostname)) return { required: false };
    const domain = target.url.hostname.toLowerCase();
    return {
      required: true,
      sessionKey: `screenshot@${domain}`,
      sessionLabel: domain,
      warnings: [`外部URL(${domain})へアクセスしてスクリーンショットを撮ります`],
      auditPaths: [target.url.href],
    };
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const target = parseTarget(input);
    if ('error' in target) return { content: target.error, isError: true };
    if (!ctx.screenshot) {
      return { content: 'この実行コンテキストではスクリーンショットを撮れない(screenshot 未注入)', isError: true };
    }
    const { width, height } = (input ?? {}) as { width?: unknown; height?: unknown };
    const w = typeof width === 'number' ? Math.min(Math.max(Math.round(width), 320), MAX_DIMENSION) : undefined;
    const h = typeof height === 'number' ? Math.min(Math.max(Math.round(height), 240), MAX_DIMENSION) : undefined;
    try {
      const shot = await ctx.screenshot.capture(target.url.href, w, h);
      return {
        content: `スクリーンショットを撮影した: ${target.url.href}`,
        images: [{ mediaType: shot.mediaType, data: shot.data, description: `screenshot: ${target.url.href}` }],
      };
    } catch (err) {
      return {
        content: `スクリーンショット失敗(${target.url.href}): ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
} satisfies ToolPlugin;
