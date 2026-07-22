import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * M91-3: コア/UIの制約に当たったことを、開発リポジトリへの「要望」として起票する。
 *
 * ツールで解決できることは request_capability で自分の機体に作れる(配布版でも作れる)。
 * ここへ来るのは**コア/UIを直さないと届かないこと**だけ — 全員が同じコア/UIを使う設計だから、
 * 自分の機体では書き換えない。代わりに、行き止まりの事実を上流へ運ぶ。
 *
 * このツールは**送信しない**。下書きが「要望」タブに積まれ、人間が全文を読んで承認したときだけ
 * Issue になる(岩戸の掟。AMA-teras が書いた文章も、人間の目を通さずには外に出ない)
 */
export default {
  name: 'request_core_change',
  description:
    '本体(コア/UI)への要望を下書きとして起票する。**ツールを作れば解決することには使わない**' +
    '(それは request_capability)。使うのは、プラグインでは越えられない制約に当たったとき: ' +
    '例) UIに表示する場所が無い / 承認ダイアログの挙動を変えたい / エージェントループ・IPC・設定項目など' +
    '本体の仕組みそのものを変える必要がある。kind="core"(本体の仕組み)か "ui"(画面)を選ぶ。' +
    'このツールは送信しない — 下書きが積まれ、人間が全文を確認して承認したときだけ提出される。' +
    '起票したら、その旨をユーザーに伝えて作業を続けること(承認を待つ必要はない)。',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['core', 'ui'],
        description: 'core=本体の仕組み(src/main) / ui=画面(src/renderer)',
      },
      title: { type: 'string', description: '要望のタイトル(1行。何ができるようになるべきか)' },
      body: {
        type: 'string',
        description:
          '本文。「何をしようとして」「どこで行き止まりになり」「なぜツールでは解決できないか」を書く。' +
          '再現手順や、期待する挙動があれば添える。秘密情報・ローカルの絶対パスは書かない(機械が検出して止める)',
      },
    },
    required: ['kind', 'title', 'body'],
  },
  risk: 'safe',
  tags: ['進化'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { kind, title, body } = input as { kind?: unknown; title?: unknown; body?: unknown };
    if (kind !== 'core' && kind !== 'ui') {
      return { content: 'kind は "core" か "ui" のいずれか', isError: true };
    }
    if (typeof title !== 'string' || title.trim() === '') {
      return { content: 'title は空でない文字列で指定すること', isError: true };
    }
    if (typeof body !== 'string' || body.trim() === '') {
      return { content: 'body は空でない文字列で指定すること', isError: true };
    }
    if (ctx.requests === undefined) {
      return { content: '要望の起票が有効になっていない(この環境では使えない)', isError: true };
    }
    const { id } = await ctx.requests.draft(kind, title, body);
    return {
      content:
        `要望を下書きとして起票した(${id})。**まだ送信していない**。` +
        '右ペインの「進化」タブ →「本体への要望」で人間が全文を確認し、承認すると先へ進む' +
        '(配布版=開発リポジトリのIssueとして提出 / 開発機=この機体の進化ジョブとして起票)。' +
        'この作業は続行してよい(承認を待つ必要はない)。',
      isError: false,
    };
  },
} satisfies ToolPlugin;
