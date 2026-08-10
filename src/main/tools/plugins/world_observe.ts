import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * M115: 世界(WORLD)の現在状態を見る。世界=ユーザーと共有する3D空間UI
 * (out/remote-ui/world.html)。自分のアバター位置・置かれたオブジェクト・
 * 世界内チャットの履歴が返る。行動する前にまず観察すること。
 */
export default {
  name: 'world_observe',
  description:
    '「世界」(ユーザーと共有する3D空間。あなたのアバターがいる)の現在状態を観察する。' +
    'アバターの位置とモーション、世界に置かれているオブジェクト一覧、世界内チャットの履歴が返る。' +
    'world_act で行動する前に必ずこれで状況を把握すること。connected:false のときは世界ページが開かれていない。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  risk: 'safe',
  tags: ['世界'],
  async execute(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.world) {
      return { content: 'このセッションには世界ブリッジが注入されていない(進化ジョブ等では使えない)', isError: true };
    }
    const obs = await ctx.world.observe(); // M173: 分離世界モードでは非同期(内蔵ならそのまま解決)
    return { content: JSON.stringify(obs, null, 1) };
  },
} satisfies ToolPlugin;
