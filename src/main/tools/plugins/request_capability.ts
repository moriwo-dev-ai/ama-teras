import type { ToolContext, ToolPlugin, ToolResult } from '../types';

export default {
  name: 'request_capability',
  description:
    '現在のツールでは対応できない要求に遭遇したときに呼ぶ。新しいツールプラグインを自動生成する進化ジョブを開始する。' +
    'ジョブは背後で 生成→検証→ユーザー承認付き昇格 まで進む。結果を待たずに応答してよい。',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '必要な能力の説明(何ができるツールが欲しいか)' },
      expected_io: { type: 'string', description: '期待する入力と出力の例' },
    },
    required: ['description', 'expected_io'],
  },
  risk: 'write',
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { description, expected_io } = input as { description?: unknown; expected_io?: unknown };
    if (typeof description !== 'string' || typeof expected_io !== 'string') {
      return { content: 'description と expected_io は文字列で指定すること', isError: true };
    }
    if (!ctx.evolution) {
      return { content: 'この実行コンテキストでは進化ジョブを起動できない', isError: true };
    }
    const { jobId } = await ctx.evolution.requestCapability(description, expected_io);
    return {
      content:
        `進化ジョブ #${jobId} を開始した。バックグラウンドで新ツールの生成と検証が進み、` +
        '合格するとユーザー承認のうえで利用可能になる。ユーザーには「進化ジョブを開始した」ことを伝えよ。',
    };
  },
} satisfies ToolPlugin;
