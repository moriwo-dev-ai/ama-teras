import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * M92-A6-2: 夜間の自動生成(バッチ)。AMA-teras 自身が「夜のうちに作っておきたいツール」を
 * まとめて起票するための口。request_capability との違いは2点だけ:
 *  1) 承認ダイアログを出さない(無人の夜間運用が前提)
 *  2) 生成物を稼働中(main)に載せず、専用ブランチ evolve/nightly へ積み上げる
 * → 朝に人間が `git log main..evolve/nightly` でまとめてレビューし、良いものを main へ取り込む。
 * 危険(child_process/network)を含むツールは無人では昇格しない(rejected)ので、
 * 「夜に安全な小物を量産 → 朝にまとめて選別」という運用に閉じている。
 */
export default {
  name: 'request_nightly_tools',
  description:
    '夜間の自動生成を一括で起票する。承認を待たずに複数の新ツールをまとめて作りたいとき(例:「今夜のうちに便利ツールを10個作っておく」)に呼ぶ。' +
    'request_capability との違い: (1) 昇格に人間承認を挟まない (2) 生成物は本体(main)に載せず専用ブランチ evolve/nightly へ積み上げ、朝にまとめてレビューする。' +
    '新ツール(scope=tool)専用。child_process/ネットワークを使うツールは無人では昇格されない(朝に手動依頼へ回る)。' +
    '各ジョブは背後で 生成→検証ゲート→専用ブランチへ自動昇格 まで進む。結果を待たずに応答してよい。',
  inputSchema: {
    type: 'object',
    properties: {
      tools: {
        type: 'array',
        description: '夜間に生成したいツールのリスト',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: '必要なツールの説明(何ができるようになりたいか)' },
            expected_io: { type: 'string', description: '期待する入力と出力の例' },
          },
          required: ['description', 'expected_io'],
        },
      },
    },
    required: ['tools'],
  },
  risk: 'write',
  tags: ['進化'],
  warnings: ['夜間の自動生成を一括起票する(生成物は専用ブランチ evolve/nightly に積まれ、朝にレビュー)'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { tools } = input as { tools?: unknown };
    if (!Array.isArray(tools) || tools.length === 0) {
      return { content: 'tools は1件以上の配列で指定すること', isError: true };
    }
    const specs: { description: string; expectedIO: string }[] = [];
    for (const [i, raw] of tools.entries()) {
      const t = raw as { description?: unknown; expected_io?: unknown };
      if (typeof t.description !== 'string' || typeof t.expected_io !== 'string') {
        return { content: `tools[${i}] の description と expected_io は文字列で指定すること`, isError: true };
      }
      specs.push({ description: t.description, expectedIO: t.expected_io });
    }
    // M27-1: 無料APIモード等で新規生成が方針無効のときは起動しない(夜間生成も生成の一種)
    if (ctx.evolutionDisabled !== undefined) {
      return { content: ctx.evolutionDisabled, isError: true };
    }
    if (!ctx.evolution?.requestNightlyTools) {
      return { content: 'この実行コンテキストでは夜間自動生成を起動できない', isError: true };
    }
    const { jobIds, branch } = await ctx.evolution.requestNightlyTools(specs);
    return {
      content:
        `夜間自動生成を${jobIds.length}件起票した(ジョブ#${jobIds.join(', #')})。` +
        `各ジョブは背後で 生成→検証ゲート に進み、合格したものは承認を待たずに専用ブランチ「${branch}」へ積み上がる` +
        `(本体=main は変更しない)。危険(child_process/ネットワーク)を含むツールは無人では昇格されない。` +
        `朝に \`git log main..${branch}\` でまとめてレビューし、採用するものを取り込むこと。` +
        `各ジョブの完了/失敗は自動通知でこの会話が再開されるので、結果を待って停止する必要はない。` +
        `ユーザーには「夜間自動生成を${jobIds.length}件開始した。朝に ${branch} でまとめてレビューできる」と伝えること。`,
    };
  },
} satisfies ToolPlugin;
