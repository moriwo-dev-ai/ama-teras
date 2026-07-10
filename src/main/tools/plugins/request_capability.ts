import type { ToolContext, ToolPlugin, ToolResult } from '../types';

export default {
  name: 'request_capability',
  description:
    '自己進化ジョブを開始する。現在のツールでは対応できない要求に遭遇したときに加え、' +
    '「専用ツールがあれば効率よく・自動でできる」と計画段階で判断したときも積極的に呼ぶこと' +
    '(既存ツールの遠回りな組み合わせで妥協しない)。' +
    'scope="tool"(既定)は新しいツールプラグインの生成。既存ツールにバグがある/機能を追加したいときは' +
    '新規作成ではなく target_tool にその既存ツール名を指定すること(該当ファイルを直接修正する。' +
    '新規作成のつもりでも生成結果が既存ツール名と衝突した場合はジョブが失敗するので、' +
    '既存ツールを直したいことが分かっているなら必ず target_tool を使うこと)。' +
    'M20: scope="renderer" はUI(src/renderer)、' +
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
      target_tool: {
        type: 'string',
        description:
          '既存ツールを修正したい場合のみ指定する(scope="tool"のときだけ意味を持つ)。' +
          '既存のツール名(例: "web_search")を指定すると、新規作成ではなくそのプラグインファイルの修正になる',
      },
    },
    required: ['description', 'expected_io'],
  },
  risk: 'write',
  tags: ['進化'],
  warnings: ['自己進化ジョブを開始する(昇格には常にユーザー承認が必要)'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { description, expected_io, scope, target_tool } = input as {
      description?: unknown;
      expected_io?: unknown;
      scope?: unknown;
      target_tool?: unknown;
    };
    if (typeof description !== 'string' || typeof expected_io !== 'string') {
      return { content: 'description と expected_io は文字列で指定すること', isError: true };
    }
    const resolvedScope =
      scope === 'renderer' || scope === 'core' ? scope : scope === undefined || scope === 'tool' ? 'tool' : null;
    if (resolvedScope === null) {
      return { content: 'scope は "tool" / "renderer" / "core" のいずれか', isError: true };
    }
    if (target_tool !== undefined && typeof target_tool !== 'string') {
      return { content: 'target_tool は文字列で指定すること', isError: true };
    }
    if (target_tool !== undefined && resolvedScope !== 'tool') {
      return { content: 'target_tool は scope="tool" のときだけ指定できる', isError: true };
    }
    // M27-1: 無料APIモード等で新規生成が方針無効のときはジョブを起動しない
    if (ctx.evolutionDisabled !== undefined) {
      return { content: ctx.evolutionDisabled, isError: true };
    }
    if (!ctx.evolution) {
      return { content: 'この実行コンテキストでは進化ジョブを起動できない', isError: true };
    }
    // target_tool未指定時は3引数のまま呼ぶ(4引数目にundefinedを明示的に渡すと
    // 呼び出し側のテストの厳密な引数一致比較を壊すため)
    const { jobId } =
      target_tool !== undefined
        ? await ctx.evolution.requestCapability(description, expected_io, resolvedScope, target_tool)
        : await ctx.evolution.requestCapability(description, expected_io, resolvedScope);
    const scopeNote =
      resolvedScope === 'tool'
        ? target_tool !== undefined
          ? `既存ツール「${target_tool}」の修正として合格するとユーザー承認のうえで反映される。`
          : '合格するとユーザー承認のうえで利用可能になる。'
        : '本体変更の提案のため、検証合格後にユーザーの二段確認と再ビルド・再起動を経て反映される。';
    return {
      content:
        `進化ジョブ #${jobId} を開始した(scope: ${resolvedScope}${target_tool !== undefined ? `, target_tool: ${target_tool}` : ''})。` +
        `バックグラウンドで生成と検証が進み、${scopeNote}` +
        `ジョブが完了/失敗すると自動通知でこの会話が再開されるので、結果を待って停止する必要はない。` +
        `ユーザーには「進化ジョブ#${jobId}を開始した。結果が出たら自動で続きを行う」と伝え、` +
        `待っている間に既存ツールで進められる作業があれば続行せよ。`,
    };
  },
} satisfies ToolPlugin;
