import type { ToolContext, ToolPlugin, ToolResult } from '../types';

export default {
  name: 'request_capability',
  description:
    '自己進化ジョブを開始する。現在のツールでは対応できない要求に遭遇したときに加え、' +
    '「専用ツールがあれば効率よく・自動でできる」と計画段階で判断したときも積極的に呼ぶこと' +
    '(既存ツールの遠回りな組み合わせで妥協しない)。' +
    'scope="tool"(既定)は新しいツールプラグインの生成。M20: scope="renderer" はUI(src/renderer)、' +
    'scope="core" は本体(src/main)の改善提案 — どちらも聖域(承認機構・進化・secrets等)には触れられず、' +
    '検証ゲート合格後に必ず人間の承認(二段確認)と再起動を経て反映される。' +
    'ジョブは背後で 生成→検証→ユーザー承認付き昇格 まで進む。結果を待たずに応答してよい。',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '必要な能力/変更の説明(何ができるようになりたいか)' },
      expected_io: { type: 'string', description: '期待する入力と出力の例(UI/コア変更では期待する挙動)' },
      scope: {
        type: 'string',
        enum: ['tool', 'renderer', 'core'],
        description: '進化スコープ。省略=tool(新ツール)。renderer=UI改善 / core=本体改善(常に人間承認+再起動)',
      },
    },
    required: ['description', 'expected_io'],
  },
  risk: 'write',
  warnings: ['自己進化ジョブを開始する(昇格には常にユーザー承認が必要)'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { description, expected_io, scope } = input as {
      description?: unknown;
      expected_io?: unknown;
      scope?: unknown;
    };
    if (typeof description !== 'string' || typeof expected_io !== 'string') {
      return { content: 'description と expected_io は文字列で指定すること', isError: true };
    }
    const resolvedScope =
      scope === 'renderer' || scope === 'core' ? scope : scope === undefined || scope === 'tool' ? 'tool' : null;
    if (resolvedScope === null) {
      return { content: 'scope は "tool" / "renderer" / "core" のいずれか', isError: true };
    }
    if (!ctx.evolution) {
      return { content: 'この実行コンテキストでは進化ジョブを起動できない', isError: true };
    }
    const { jobId } = await ctx.evolution.requestCapability(description, expected_io, resolvedScope);
    const scopeNote =
      resolvedScope === 'tool'
        ? '合格するとユーザー承認のうえで利用可能になる。'
        : '本体変更の提案のため、検証合格後にユーザーの二段確認と再ビルド・再起動を経て反映される。';
    return {
      content:
        `進化ジョブ #${jobId} を開始した(scope: ${resolvedScope})。バックグラウンドで生成と検証が進み、` +
        `${scopeNote}ユーザーには「進化ジョブを開始した」ことを伝えよ。`,
    };
  },
} satisfies ToolPlugin;
